# CRM Setup & Deployment Checklist

Everything needed to go from local development to a working production system.

---

## Phase 1: External Service Accounts (Do First)

### 1.1 Gemini AI — Upgrade to Paid (~5 min)
**Currently:** Free tier, hits rate limits on 3+ requests
**What it enables:** AI assistant, email drafts, landing page generation, onboarding pipeline suggestions

- [ ] Go to https://aistudio.google.com/apikey
- [ ] Click on your existing key
- [ ] Enable billing / upgrade to pay-as-you-go
- [ ] Verify: test the AI assistant chat in the CRM — should respond without "Resource exhausted" errors
- [ ] Estimated cost: ~$5-20/month for typical usage

### 1.2 Resend — Email Sending (~15 min)
**Currently:** No email sending at all. Signup uses dev bypass.
**What it enables:** Signup verification, email compose, email campaigns, invoice emails, booking confirmations

- [ ] Sign up at https://resend.com (free tier: 3,000 emails/month)
- [ ] Dashboard → API Keys → Create API Key → copy it
- [ ] Dashboard → Domains → Add Domain
  - [ ] Enter your domain (e.g., `yourdomain.com`)
  - [ ] Add the DNS records Resend provides:
    - [ ] SPF record (TXT)
    - [ ] DKIM record (TXT, multiple)
    - [ ] DMARC record (TXT) — recommended: `v=DMARC1; p=none;`
  - [ ] Wait for verification (5-15 minutes, sometimes up to 24 hours)
- [ ] Add to .env: `RESEND_API_KEY=re_xxxxx`
- [ ] Add to .env: `EMAIL_FROM=hello@yourdomain.com`
- [ ] Test: go to /onboarding → sign up → should receive verification email
- [ ] Test: open a contact → Email → Compose → Send → should deliver

### 1.3 Stripe — Payments (~15 min)
**Currently:** Payment buttons exist but do nothing
**What it enables:** Payment links on products/invoices, checkout pages, course purchases, payment tracking

- [ ] Sign up at https://stripe.com (or log in to existing account)
- [ ] Dashboard → Developers → API keys
  - [ ] Copy "Secret key" (starts with `sk_test_` for test mode)
- [ ] Dashboard → Developers → Webhooks → Add endpoint
  - [ ] Endpoint URL: `https://YOUR_DOMAIN/api/stripe/webhook`
  - [ ] Select events: `checkout.session.completed`
  - [ ] Copy the "Signing secret" (starts with `whsec_`)
- [ ] Add to .env: `STRIPE_SECRET_KEY=sk_test_xxxxx`
- [ ] Add to .env: `STRIPE_WEBHOOK_SECRET=whsec_xxxxx`
- [ ] Test: create a product → click "Payment Link" → complete test payment with card 4242424242424242 → verify invoice marked paid
- [ ] For production: switch to live keys (sk_live_...) after testing

### 1.4 Twilio — SMS (~15 min)
**Currently:** SMS buttons exist but messages don't send
**What it enables:** Send/receive text messages from contact detail, SMS in automations

- [ ] Sign up at https://twilio.com (free trial includes $15 credit)
- [ ] Console → Dashboard → copy Account SID and Auth Token
- [ ] Console → Phone Numbers → Buy a Number
  - [ ] Pick a local number with SMS capability (~$1/month)
  - [ ] Note: free trial can only send to verified numbers. Upgrade to send to anyone.
- [ ] Console → Phone Numbers → your number → Messaging Configuration
  - [ ] Webhook URL: `https://YOUR_DOMAIN/api/sms/webhook`
  - [ ] HTTP Method: POST
- [ ] Add to .env: `TWILIO_ACCOUNT_SID=ACxxxxx`
- [ ] Add to .env: `TWILIO_AUTH_TOKEN=xxxxx`
- [ ] Add to .env: `TWILIO_PHONE_NUMBER=+1xxxxxxxxxx`
- [ ] Test: open a contact with a phone number → Text → send SMS → verify received

### 1.5 Google Calendar — Calendar Sync (~20 min, do after deployment)
**Currently:** Code built but needs OAuth credentials with live redirect URI
**What it enables:** Google Calendar sync, availability blocking on booking pages

- [ ] Go to https://console.cloud.google.com
- [ ] Create project (or use existing)
- [ ] APIs & Services → Library → search "Google Calendar API" → Enable
- [ ] APIs & Services → OAuth consent screen
  - [ ] User type: External
  - [ ] App name: "CRM" (or your brand)
  - [ ] Add scopes: `calendar.readonly`, `calendar.events`
  - [ ] Add test users (your email) during testing
- [ ] APIs & Services → Credentials → Create Credentials → OAuth Client ID
  - [ ] Application type: Web application
  - [ ] Authorized redirect URI: `https://YOUR_DOMAIN/api/google/callback`
  - [ ] Copy Client ID and Client Secret
- [ ] Add to .env: `GOOGLE_OAUTH_CLIENT_ID=xxxxx.apps.googleusercontent.com`
- [ ] Add to .env: `GOOGLE_OAUTH_CLIENT_SECRET=xxxxx`
- [ ] Test: Settings → Calendar → Connect Google Calendar → authorize → create booking page → verify events sync

---

## Phase 2: Server Deployment — Hetzner

### 2.1 Server Setup
- [ ] SSH into your Hetzner VPS
- [ ] Install Node 24: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`
- [ ] Install Docker + Docker Compose (if not already for LaunchBot)
- [ ] Install Nginx: `sudo apt install nginx`
- [ ] Install Certbot for SSL: `sudo apt install certbot python3-certbot-nginx`

### 2.2 Clone & Build
```bash
cd /opt
git clone https://github.com/wesleybhansen/crm.git
cd crm
cp apps/mercato/.env.production.example apps/mercato/.env
# Edit .env with all your API keys and secrets
nano apps/mercato/.env
```

### 2.3 Database Setup
```bash
# If using Docker for Postgres:
docker run -d --name crm-postgres \
  -e POSTGRES_USER=crm \
  -e POSTGRES_PASSWORD=YOUR_STRONG_PASSWORD \
  -e POSTGRES_DB=crm \
  -p 5432:5432 \
  -v crm-pgdata:/var/lib/postgresql/data \
  pgvector/pgvector:pg17-trixie

# If Postgres is already running (shared with LaunchBot):
sudo -u postgres createuser crm
sudo -u postgres createdb crm -O crm
sudo -u postgres psql -c "ALTER USER crm WITH PASSWORD 'YOUR_STRONG_PASSWORD';"
```

### 2.4 Build & Initialize
```bash
corepack enable
yarn install
yarn build:packages
yarn generate
yarn build
yarn initialize  # Seeds database, creates admin user
```

### 2.5 Run Database Migrations for Custom Modules
```bash
# Connect to the database and run the custom table creation SQL
psql -U crm -d crm < setup-tables.sql
```
Note: We need to create a setup-tables.sql file with all our custom table creations.

### 2.6 Nginx Configuration
```nginx
server {
    server_name crm.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

### 2.7 SSL Certificate
```bash
sudo certbot --nginx -d crm.yourdomain.com
```

### 2.8 Start the App
```bash
# Using PM2 (recommended):
npm install -g pm2
cd /opt/crm
pm2 start "yarn start" --name crm
pm2 save
pm2 startup

# Or using Docker:
docker-compose -f docker-compose.fullapp.yml up -d
```

### 2.9 DNS
- [ ] Add A record: `crm.yourdomain.com` → your Hetzner VPS IP
- [ ] Wait for DNS propagation (5-30 minutes)

---

## Phase 3: End-to-End Testing

### 3.1 Signup Flow
- [ ] Visit https://crm.yourdomain.com/onboarding
- [ ] Fill in signup form → receive verification email
- [ ] Click verification link → redirected to login
- [ ] Log in → redirected to welcome wizard
- [ ] Complete wizard → arrive at dashboard

### 3.2 Landing Pages
- [ ] Create a landing page (pick template → fill wizard → generate)
- [ ] Publish the page
- [ ] Visit the public URL
- [ ] Submit the form
- [ ] Verify contact appears in Contacts
- [ ] Verify activity logged on the contact

### 3.3 Email
- [ ] Open a contact → Email → Compose
- [ ] Use AI Draft → generates subject + body
- [ ] Send the email
- [ ] Check if email arrives
- [ ] Verify open tracking works

### 3.4 Payments
- [ ] Create a product ($10 test)
- [ ] Click "Payment Link" → copy URL
- [ ] Open URL → complete payment (test card: 4242 4242 4242 4242)
- [ ] Verify invoice marked as paid
- [ ] Verify contact created (if new customer)

### 3.5 Booking
- [ ] Create a booking page
- [ ] Copy the booking link
- [ ] Open the public booking page
- [ ] Book an appointment
- [ ] Verify booking appears in Calendar
- [ ] Verify contact created in CRM
- [ ] If Google Calendar connected: verify event appears on Google Calendar

### 3.6 SMS
- [ ] Open a contact with phone number
- [ ] Click Text → send message
- [ ] Verify SMS received on phone

### 3.7 Campaigns
- [ ] Create an email campaign
- [ ] Select a tag filter (optional)
- [ ] Send to contacts
- [ ] Verify emails delivered

### 3.8 Courses
- [ ] Create a course (free)
- [ ] Publish it
- [ ] Enroll a student via API
- [ ] Verify enrollment count

### 3.9 AI Features
- [ ] AI Assistant responds to questions
- [ ] Landing page AI generates content
- [ ] Email AI drafts work
- [ ] Onboarding pipeline suggestions work

---

## Phase 4: Post-Launch

- [ ] Switch Stripe to live keys
- [ ] Monitor Gemini AI usage (Settings → AI Usage)
- [ ] Set up database backups: `pg_dump crm > backup-$(date +%F).sql`
- [ ] Set up error monitoring (Sentry — optional)
- [ ] Set up uptime monitoring (UptimeRobot — free)
- [ ] Review and adjust AI usage cap in admin settings
