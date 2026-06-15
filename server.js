/**
 * Humanz+ Client Intelligence Hub v2
 * Hosted Node.js server: HubSpot + Gmail + Slack + Anthropic AI
 */

import express       from 'express';
import cors          from 'cors';
import session       from 'express-session';
import fetch         from 'node-fetch';
import cron          from 'node-cron';
import path          from 'path';
import { fileURLToPath } from 'url';
import { google }    from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'humanz-dev-secret', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));

const SIGNED   = new Set(['171064158','1214467345','1293357702','1317541963','1207707140','6350711','1326715243','1293357698','1323407699']);
const LOST     = new Set(['171064159','1214467346','1293357703','1317541964','1207707141','6350712','1101133726','29241252','9597534','171064157']);
const BAD_PIPE = new Set(['1558425','1793821','1793838','1666901','17494611','96250238','823896834']);

async function fetchHubSpotDeals() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { error: 'HUBSPOT_TOKEN not set' };
  const body = {
    limit: 200,
    properties: ['dealname','dealstage','pipeline','closedate','createdate',
      'hs_lastactivitydate','hs_lastmodifieddate','amount','deal_currency_code','hubspot_owner_id'],
    filterGroups: [{
      filters: [
        { propertyName: 'pipeline',  operator: 'NOT_IN', values: [...BAD_PIPE] },
        { propertyName: 'dealstage', operator: 'NOT_IN', values: [...LOST] },
      ]
    }],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
  };
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return r.json();
}

function classifyDeal(deal) {
  const s = deal.properties.dealstage;
  const p = deal.properties.pipeline;
  if (LOST.has(s) || BAD_PIPE.has(p)) return null;
  if (SIGNED.has(s) && deal.properties.closedate) {
    const days = Math.floor((Date.now() - new Date(deal.properties.closedate)) / 86400000);
    return days <= 30 ? 'onboarding' : 'active';
  }
  return 'pipeline';
}

function dealUrgency(deal, phase) {
  if (!deal.properties.hubspot_owner_id) return 'no-am';
  const lastAct = Math.floor((Date.now() - new Date(deal.properties.hs_lastactivitydate || deal.properties.hs_lastmodifieddate)) / 86400000);
  if (phase === 'pipeline'   && lastAct > 14) return 'high';
  if (phase === 'onboarding' && lastAct > 7)  return 'high';
  if (phase === 'active'     && lastAct > 21) return 'high';
  if (lastAct > 7) return 'medium';
  return 'low';
}

function getGmailClient() {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE}/auth/google/callback`
  );
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return oauth2;
}

async function fetchRecentEmails(maxResults = 20) {
  const auth = getGmailClient();
  if (!auth || !process.env.GOOGLE_REFRESH_TOKEN) return { error: 'Gmail not configured' };
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({ userId: 'me', maxResults, q: 'in:inbox newer_than:7d -from:me' });
  const messages = list.data.messages || [];
  const details = await Promise.all(
    messages.slice(0, 10).map(async m => {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['From','Subject','Date'] });
      const headers = msg.data.payload.headers;
      const get = n => (headers.find(h => h.name === n) || {}).value || '';
      return { id: m.id, from: get('From'), subject: get('Subject'), date: get('Date'), snippet: msg.data.snippet };
    })
  );
  return { emails: details };
}

async function fetchSlackMentions() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { error: 'SLACK_BOT_TOKEN not set' };
  const r = await fetch('https://slack.com/api/search.messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: 'in:#client-onboarding-group after:2026-05-01', count: 20 }),
  });
  return r.json();
}

async function sendSlackDM(userId, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: userId, text }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

async function askClaude(system, userMsg, maxTokens = 800) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

async function generateClientInsight(deal, phase) {
  const name = deal.properties.dealname.split('|')[1]?.trim() || deal.properties.dealname;
  const lastAct = Math.floor((Date.now() - new Date(deal.properties.hs_lastactivitydate || deal.properties.hs_lastmodifieddate)) / 86400000);
  const prompt = `Client: ${name} | Phase: ${phase} | Last contact: ${lastAct}d ago${deal.properties.amount ? ` | Value: ${deal.properties.amount} ${deal.properties.deal_currency_code||'USD'}` : ''}${!deal.properties.hubspot_owner_id ? ' | No AM assigned' : ''}\nGive 2 sentences: risk level + recommended action.`;
  return askClaude('You are a client success analyst at Humanz+. Be concise and actionable.', prompt, 200);
}

async function generateDraftMessage(deal, phase) {
  const parts = deal.properties.dealname.split('|').map(x => x.trim());
  const company = parts[1] || parts[0];
  const contact = parts.length > 1 ? parts[0] : '';
  const lastAct = Math.floor((Date.now() - new Date(deal.properties.hs_lastactivitydate || deal.properties.hs_lastmodifieddate)) / 86400000);
  const kind = phase === 'pipeline' ? 'follow-up sales' : phase === 'onboarding' ? 'onboarding check-in' : 'satisfaction check-in';
  const prompt = `Write a short warm ${kind} email for ${company}${contact ? ', contact: ' + contact : ''}.\nLast contact: ${lastAct}d ago. ${deal.properties.amount ? 'Value: ' + deal.properties.amount + ' ' + (deal.properties.deal_currency_code||'USD') : ''}\nUnder 100 words. Subject: line first, then body. Sign off: The Humanz+ Team.`;
  return askClaude('You are a senior account manager at Humanz+. Write warm, professional client emails.', prompt, 300);
}

async function sendDailyBriefing() {
  console.log('Sending daily briefing...');
  try {
    const hsData = await fetchHubSpotDeals();
    const deals  = (hsData.results || []);
    const classified = deals.map(d => ({ ...d, phase: classifyDeal(d), urgency: dealUrgency(d, classifyDeal(d)) })).filter(d => d.phase);
    const pipeline   = classified.filter(d => d.phase === 'pipeline');
    const onboarding = classified.filter(d => d.phase === 'onboarding');
    const active     = classified.filter(d => d.phase === 'active');
    const urgent     = classified.filter(d => ['high','no-am'].includes(d.urgency));
    const briefText = await askClaude(
      'You are an AI assistant for Humanz+. Generate a concise daily client briefing.',
      `Data as of ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}:\nPipeline: ${pipeline.length} | Onboarding: ${onboarding.length} | Active: ${active.length}\nUrgent: ${urgent.length}\nTop urgent: ${urgent.slice(0,3).map(d=>d.properties.dealname.split('|')[1]?.trim()||d.properties.dealname).join(', ')}\n\nWrite a 5-bullet morning briefing.`,
      600
    );
    const slackMsg = `Good morning Adi! Humanz+ Daily Briefing\n\n${briefText}\n\nDashboard: ${BASE}`;
    await sendSlackDM(process.env.SLACK_NOTIFY_USER || 'U0ATN0LR056', slackMsg);
    console.log('Daily briefing sent');
  } catch (e) {
    console.error('Briefing failed:', e.message);
  }
}

cron.schedule('0 5 * * 1-5', sendDailyBriefing, { timezone: 'Asia/Jerusalem' });

app.get('/auth/google', (req, res) => {
  const auth = getGmailClient();
  if (!auth) return res.status(500).json({ error: 'Google not configured' });
  const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'] });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const auth = getGmailClient();
  const { tokens } = await auth.getToken(req.query.code);
  req.session.googleTokens = tokens;
  res.send(`<h2>Google connected!</h2><p>Copy this refresh token to Railway env vars:</p><code>${tokens.refresh_token}</code><br><a href="/">Back</a>`);
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [hsData, emailData] = await Promise.allSettled([fetchHubSpotDeals(), fetchRecentEmails()]);
    const deals = (hsData.value?.results || []).map(d => {
      const phase = classifyDeal(d);
      return { ...d, phase, urgency: dealUrgency(d, phase) };
    }).filter(d => d.phase);
    res.json({
      deals,
      emails: emailData.value?.emails || [],
      stats: {
        pipeline:   deals.filter(d => d.phase === 'pipeline').length,
        onboarding: deals.filter(d => d.phase === 'onboarding').length,
        active:     deals.filter(d => d.phase === 'active').length,
        urgent:     deals.filter(d => ['high','no-am'].includes(d.urgency)).length,
      },
      connected: { hubspot: !!process.env.HUBSPOT_TOKEN, gmail: !!process.env.GOOGLE_REFRESH_TOKEN, slack: !!process.env.SLACK_BOT_TOKEN },
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/insight', async (req, res) => {
  try { const { deal, phase } = req.body; res.json({ insight: await generateClientInsight(deal, phase) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/draft', async (req, res) => {
  try { const { deal, phase } = req.body; res.json({ draft: await generateDraftMessage(deal, phase) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/slack/send', async (req, res) => {
  try { const { userId, text } = req.body; await sendSlackDM(userId || process.env.SLACK_NOTIFY_USER, text); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gmail/draft', async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const auth = getGmailClient();
    if (!auth || !process.env.GOOGLE_REFRESH_TOKEN) return res.status(400).json({ error: 'Gmail not configured. Visit /auth/google first.' });
    const gmail = google.gmail({ version: 'v1', auth });
    const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString('base64url');
    const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    res.json({ ok: true, draftId: draft.data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/briefing/send', async (req, res) => {
  sendDailyBriefing();
  res.json({ ok: true, message: 'Briefing triggered' });
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString(),
  hubspot: !!process.env.HUBSPOT_TOKEN, gmail: !!process.env.GOOGLE_REFRESH_TOKEN,
  slack: !!process.env.SLACK_BOT_TOKEN, claude: !!process.env.ANTHROPIC_API_KEY }));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Humanz+ Client Intelligence Hub running on ${BASE}`);
  console.log(`  HubSpot: ${process.env.HUBSPOT_TOKEN ? 'OK' : 'missing HUBSPOT_TOKEN'}`);
  console.log(`  Gmail:   ${process.env.GOOGLE_REFRESH_TOKEN ? 'OK' : 'visit /auth/google'}`);
  console.log(`  Slack:   ${process.env.SLACK_BOT_TOKEN ? 'OK' : 'missing SLACK_BOT_TOKEN'}`);
  console.log(`  Claude:  ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'missing ANTHROPIC_API_KEY'}`);
});
