# Aark Realty local backend

## What this adds

- Serves `abc.html` from `http://localhost:3000`
- Receives enquiry, contact, and career form submissions
- Saves all submissions to `data/submissions.jsonl`
- Emails the owner when SMTP is configured
- Serves brochure PDFs from `brochures/manifest.json` when available
- Falls back to a generated brochure PDF for each property

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your Gmail SMTP details
3. Start the server:

```powershell
node server.js
```

4. Open `http://localhost:3000`

## Gmail note

For Gmail, use an App Password, not your normal Gmail password. The account used in `SMTP_USER` must have 2-step verification enabled first.

## Brochure management

- Put brochure PDFs in the `brochures` folder
- Map property ids to files in `brochures/manifest.json`
- Replace a brochure later by overwriting the PDF or updating the manifest entry

## Deploy on aarkrealty.com

One practical setup is:

1. Put this project on a VPS or cloud VM
2. Install Node.js
3. Run the app with:

```powershell
node server.js
```

4. Put Nginx in front of it and proxy `aarkrealty.com` to `http://localhost:3000`
5. Point your domain DNS `A` record to the server IP
6. Add SSL with Let's Encrypt

If you want the app to stay running after reboot, use a process manager like `pm2` or a system service.
"# aarkWeb" 
