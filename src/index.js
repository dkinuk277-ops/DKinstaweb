const SESSION_COOKIE = 'dk_admin';
const MAX_TEXT = 5000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers }
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clean(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sessionToken(env) {
  return sha256('dkinstaweb:' + env.ADMIN_PASSWORD);
}

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)'));
  if (!m) return false;
  return m[1] === (await sessionToken(env));
}

/* ---------------- Schema ---------------- */

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'contact',
      first_name TEXT,
      last_name TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      description TEXT,
      region TEXT,
      region_other TEXT,
      org_type TEXT,
      industry TEXT,
      pages TEXT,
      purpose TEXT,
      features TEXT,
      content_state TEXT,
      ongoing TEXT,
      scope TEXT,
      recommended_plan TEXT,
      recommended_price TEXT,
      selected_plan TEXT,
      selected_price TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
    )`
  ).run();

  // Additive migrations for databases created before these columns existed.
  const extras = ['recommended_price TEXT', 'selected_price TEXT'];
  for (const col of extras) {
    try {
      await env.DB.prepare('ALTER TABLE submissions ADD COLUMN ' + col).run();
    } catch (_) {
      // Column already present.
    }
  }
}

/* ---------------- Email ---------------- */

async function sendEmail(env, subject, lines, replyTo) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO || !env.NOTIFY_FROM) return;

  const payload = {
    from: env.NOTIFY_FROM,
    to: [env.NOTIFY_TO],
    subject,
    text: lines.join('\n')
  };
  if (replyTo) payload.reply_to = replyTo;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log('Resend failed', res.status, await res.text());
    }
  } catch (err) {
    console.log('Resend error', err && err.message);
  }
}

/* ---------------- Pages ---------------- */

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#0A1428;color:#F0EDE4;line-height:1.55;-webkit-font-smoothing:antialiased}
  .badge{background:#F59E0B;color:#0A1428;padding:4px 8px;border-radius:3px;font-size:.72rem;letter-spacing:.14em;font-weight:700;font-family:'JetBrains Mono',monospace}
  a{color:inherit}
`;

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DK Instaweb — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${BASE_CSS}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
  .card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:2.5rem;width:100%;max-width:400px}
  h1{font-family:'Sora',sans-serif;font-size:1.35rem;font-weight:500;margin:1.25rem 0 1.75rem;color:#FFF9EC}
  label{display:block;font-family:'JetBrains Mono',monospace;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#8B95A5;margin-bottom:.4rem}
  input{width:100%;padding:.75rem .9rem;background:#0A1428;border:1px solid rgba(255,255,255,.14);border-radius:3px;color:#F0EDE4;font-family:'Inter',sans-serif;font-size:.95rem}
  input:focus{outline:none;border-color:#F59E0B}
  button{width:100%;margin-top:1.25rem;padding:.85rem;background:#F59E0B;color:#0A1428;border:none;border-radius:3px;font-weight:700;font-size:.95rem;cursor:pointer;font-family:'Inter',sans-serif}
  .err{margin-top:1rem;padding:.7rem;background:rgba(248,113,113,.1);border:1px solid #F87171;border-radius:3px;color:#F87171;font-size:.85rem;text-align:center}
</style></head><body>
<form class="card" method="POST" action="/admin/login">
  <span class="badge">DK</span>
  <h1>Admin console</h1>
  <label for="p">Password</label>
  <input id="p" type="password" name="password" required autofocus>
  <button type="submit">Sign in</button>
  ${error ? '<div class="err">' + esc(error) + '</div>' : ''}
</form></body></html>`;
}

function detailRow(k, v) {
  if (!v) return '';
  return '<div class="d-row"><span class="d-k">' + esc(k) + '</span><span class="d-v">' + esc(v) + '</span></div>';
}

function adminPage(rows) {
  const total = rows.length;
  const newCount = rows.filter((r) => r.status === 'new').length;
  const quotes = rows.filter((r) => r.kind === 'quote').length;

  const items = rows.length
    ? rows
        .map((r) => {
          const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)';
          const isQuote = r.kind === 'quote';
          const regionLabel =
            r.region === 'in' ? 'India' : r.region === 'uk' ? 'United Kingdom' : r.region_other || r.region || '';

          const details = isQuote
            ? '<div class="details">' +
              detailRow('Region', regionLabel) +
              detailRow('Organisation', r.org_type) +
              detailRow('Industry', r.industry) +
              detailRow('Pages', r.pages) +
              detailRow('Goal', r.purpose) +
              detailRow('Content areas', r.features) +
              detailRow('Content ready', r.content_state) +
              detailRow('After launch', r.ongoing) +
              detailRow('Assessed scope', r.scope) +
              detailRow('Recommended', r.recommended_plan ? r.recommended_plan + (r.recommended_price ? ' — ' + r.recommended_price : '') : '') +
              detailRow('Plan requested', r.selected_plan ? r.selected_plan + (r.selected_price ? ' — ' + r.selected_price : '') : '') +
              '</div>'
            : '';

          return `
      <div class="item${r.status === 'new' ? ' is-new' : ''}">
        <div class="item-head">
          <div>
            <div class="item-name">${esc(name)}
              <span class="kind kind-${isQuote ? 'quote' : 'contact'}">${isQuote ? 'QUOTE' : 'CONTACT'}</span>
            </div>
            <a class="item-email" href="mailto:${esc(r.email)}">${esc(r.email)}</a>
            ${r.phone ? '<a class="item-phone" href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a>' : ''}
          </div>
          <div class="item-meta">
            <span class="date">${esc(new Date(r.created_at).toLocaleString('en-GB'))}</span>
            ${r.status === 'new' ? '<span class="tag">NEW</span>' : ''}
          </div>
        </div>
        ${r.description ? '<p class="item-desc">' + esc(r.description) + '</p>' : ''}
        ${details}
        <div class="item-actions">
          <form method="POST" action="/admin/status">
            <input type="hidden" name="id" value="${r.id}">
            <input type="hidden" name="status" value="${r.status === 'new' ? 'read' : 'new'}">
            <button class="ghost" type="submit">Mark as ${r.status === 'new' ? 'read' : 'new'}</button>
          </form>
          <form method="POST" action="/admin/delete" onsubmit="return confirm('Delete this submission?')">
            <input type="hidden" name="id" value="${r.id}">
            <button class="ghost danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`;
        })
        .join('')
    : '<div class="empty">No submissions yet.</div>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DK Instaweb — Submissions</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${BASE_CSS}
  .wrap{max-width:900px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
  header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;padding-bottom:1.5rem;border-bottom:1px solid rgba(255,255,255,.08)}
  .brand{display:flex;align-items:center;gap:.55rem;font-family:'Sora',sans-serif;font-weight:600;font-size:1.1rem;color:#FFF9EC}
  .logout{font-family:'JetBrains Mono',monospace;font-size:.78rem;letter-spacing:.06em;color:#8B95A5;text-decoration:none;border:1px solid rgba(255,255,255,.14);padding:.45rem .8rem;border-radius:3px}
  .logout:hover{color:#F59E0B;border-color:#F59E0B}
  h1{font-family:'Sora',sans-serif;font-size:2rem;font-weight:500;letter-spacing:-.02em;color:#FFF9EC;margin:2rem 0 .35rem}
  .sub{font-family:'JetBrains Mono',monospace;font-size:.78rem;letter-spacing:.08em;color:#8B95A5;text-transform:uppercase;margin-bottom:2rem}
  .item{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:5px;padding:1.4rem;margin-bottom:1rem}
  .item.is-new{border-left:3px solid #F59E0B}
  .item-head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.75rem}
  .item-name{font-family:'Sora',sans-serif;font-size:1.1rem;font-weight:500;color:#FFF9EC;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
  .kind{font-family:'JetBrains Mono',monospace;font-size:.6rem;font-weight:700;letter-spacing:.1em;padding:2px 6px;border-radius:2px}
  .kind-quote{background:rgba(245,158,11,.15);color:#F59E0B;border:1px solid rgba(245,158,11,.4)}
  .kind-contact{background:rgba(255,255,255,.07);color:#8B95A5;border:1px solid rgba(255,255,255,.14)}
  .item-email{font-size:.88rem;color:#8B95A5;text-decoration:none;display:block;margin-top:.25rem}
  .item-email:hover{color:#F59E0B}
  .item-phone{display:block;font-family:'JetBrains Mono',monospace;font-size:.82rem;color:#8B95A5;text-decoration:none;margin-top:.2rem}
  .item-phone:hover{color:#F59E0B}
  .item-meta{text-align:right;display:flex;align-items:center;gap:.6rem}
  .date{font-family:'JetBrains Mono',monospace;font-size:.75rem;color:#6B7688}
  .tag{background:#F59E0B;color:#0A1428;font-family:'JetBrains Mono',monospace;font-size:.65rem;font-weight:700;padding:2px 6px;border-radius:2px;letter-spacing:.08em}
  .item-desc{font-size:.94rem;color:#C9CFD9;white-space:pre-wrap;padding-top:.75rem;border-top:1px solid rgba(255,255,255,.06)}
  .details{margin-top:.9rem;padding-top:.75rem;border-top:1px solid rgba(255,255,255,.06)}
  .d-row{display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;font-size:.85rem}
  .d-k{font-family:'JetBrains Mono',monospace;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:#6B7688;flex-shrink:0}
  .d-v{color:#C9CFD9;text-align:right}
  .item-actions{display:flex;gap:.5rem;margin-top:1rem}
  .ghost{background:transparent;border:1px solid rgba(255,255,255,.14);color:#8B95A5;padding:.4rem .75rem;border-radius:3px;font-size:.78rem;font-family:'JetBrains Mono',monospace;cursor:pointer}
  .ghost:hover{border-color:#F59E0B;color:#F59E0B}
  .ghost.danger:hover{border-color:#F87171;color:#F87171}
  .empty{padding:3rem;text-align:center;color:#6B7688;border:1px dashed rgba(255,255,255,.12);border-radius:5px}
</style></head><body>
  <div class="wrap">
    <header>
      <div class="brand"><span class="badge">DK</span><span>Instaweb</span></div>
      <a class="logout" href="/admin/logout">SIGN OUT</a>
    </header>
    <h1>Submissions</h1>
    <div class="sub">${total} total · ${newCount} new · ${quotes} from quote survey</div>
    ${items}
  </div>
</body></html>`;
}

/* ---------------- Worker ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* ---- Contact form (homepage) ---- */
    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const b = await request.json();
        const first = clean(b.first_name, 80);
        const last = clean(b.last_name, 80);
        const email = clean(b.email, 160);
        const phone = clean(b.phone, 40);
        const description = clean(b.description, MAX_TEXT);

        if (!first || !last || !email || !description) {
          return json({ error: 'All required fields must be filled.' }, 400);
        }
        if (!validEmail(email)) return json({ error: 'Invalid email address.' }, 400);

        await ensureSchema(env);
        const created_at = new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO submissions (kind, first_name, last_name, email, phone, description, created_at, status)
           VALUES ('contact', ?, ?, ?, ?, ?, ?, 'new')`
        )
          .bind(first, last, email, phone || null, description, created_at)
          .run();

        ctx.waitUntil(
          sendEmail(
            env,
            'New enquiry — ' + first + ' ' + last,
            [
              'Name: ' + first + ' ' + last,
              'Email: ' + email,
              'Phone: ' + (phone || 'Not provided'),
              'Received: ' + created_at,
              '',
              description,
              '',
              '--',
              'View all: https://dkinstaweb.com/admin'
            ],
            email
          )
        );

        return json({ ok: true });
      } catch (err) {
        return json({ error: 'Server error.' }, 500);
      }
    }

    /* ---- Quote survey ---- */
    if (path === '/api/quote' && request.method === 'POST') {
      try {
        const b = await request.json();
        const first = clean(b.first_name, 80);
        const last = clean(b.last_name, 80);
        const email = clean(b.email, 160);

        if (!first || !last || !email) return json({ error: 'Missing details.' }, 400);
        if (!validEmail(email)) return json({ error: 'Invalid email address.' }, 400);

        await ensureSchema(env);
        const created_at = new Date().toISOString();

        const region = clean(b.region, 20);
        const regionOther = clean(b.region_other, 80);
        const features = Array.isArray(b.features) ? b.features.join(', ').slice(0, 400) : clean(b.features, 400);

        const res = await env.DB.prepare(
          `INSERT INTO submissions
             (kind, first_name, last_name, email, region, region_other, org_type, industry,
              pages, purpose, features, content_state, ongoing, scope, recommended_plan,
              recommended_price, created_at, status)
           VALUES ('quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
        )
          .bind(
            first,
            last,
            email,
            region || null,
            regionOther || null,
            clean(b.org_type, 60) || null,
            clean(b.industry, 60) || null,
            clean(b.pages, 40) || null,
            clean(b.purpose, 60) || null,
            features || null,
            clean(b.content_state, 40) || null,
            clean(b.ongoing, 60) || null,
            clean(b.scope, 40) || null,
            clean(b.recommended_plan, 60) || null,
            clean(b.recommended_price, 60) || null,
            created_at
          )
          .run();

        const regionLabel =
          region === 'in' ? 'India' : region === 'uk' ? 'United Kingdom' : regionOther || 'International';

        ctx.waitUntil(
          sendEmail(
            env,
            'Quote request — ' + first + ' ' + last + ' (' + regionLabel + ')',
            [
              'Name: ' + first + ' ' + last,
              'Email: ' + email,
              'Region: ' + regionLabel,
              'Received: ' + created_at,
              '',
              'Organisation: ' + (clean(b.org_type, 60) || '-'),
              'Industry: ' + (clean(b.industry, 60) || '-'),
              'Pages: ' + (clean(b.pages, 40) || '-'),
              'Goal: ' + (clean(b.purpose, 60) || '-'),
              'Content areas: ' + (features || '-'),
              'Content ready: ' + (clean(b.content_state, 40) || '-'),
              'After launch: ' + (clean(b.ongoing, 60) || '-'),
              '',
              'Assessed scope: ' + (clean(b.scope, 40) || '-'),
              'Recommended plan: ' + (clean(b.recommended_plan, 60) || '-'),
              'Quoted price: ' + (clean(b.recommended_price, 60) || '-'),
              '',
              '--',
              'View all: https://dkinstaweb.com/admin'
            ],
            email
          )
        );

        return json({ ok: true, id: res.meta && res.meta.last_row_id });
      } catch (err) {
        return json({ error: 'Server error.' }, 500);
      }
    }

    /* ---- Plan click ---- */
    if (path === '/api/quote/plan' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = parseInt(b.id, 10);
        const plan = clean(b.plan, 60);
        const price = clean(b.price, 60);
        if (!Number.isFinite(id) || !plan) return json({ error: 'Bad request.' }, 400);

        await ensureSchema(env);
        await env.DB.prepare(
          'UPDATE submissions SET selected_plan = ?, selected_price = ?, status = ? WHERE id = ?'
        )
          .bind(plan, price || null, 'new', id)
          .run();

        const { results } = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).all();
        const row = results && results[0];

        if (row) {
          const regionLabel =
            row.region === 'in' ? 'India' : row.region === 'uk' ? 'United Kingdom' : row.region_other || 'International';

          ctx.waitUntil(
            sendEmail(
              env,
              'Plan requested: ' + plan + ' — ' + row.first_name + ' ' + row.last_name,
              [
                row.first_name + ' ' + row.last_name + ' asked for a quote on the ' + plan + ' plan.',
                '',
                'PLAN REQUESTED: ' + plan + (price ? ' (' + price + ')' : ''),
                '',
                'Email: ' + row.email,
                'Region: ' + regionLabel,
                '',
                'Organisation: ' + (row.org_type || '-'),
                'Industry: ' + (row.industry || '-'),
                'Pages: ' + (row.pages || '-'),
                'Goal: ' + (row.purpose || '-'),
                'Content areas: ' + (row.features || '-'),
                'Content ready: ' + (row.content_state || '-'),
                'After launch: ' + (row.ongoing || '-'),
                '',
                'Assessed scope: ' + (row.scope || '-'),
                'We recommended: ' + (row.recommended_plan || '-') +
                  (row.recommended_price ? ' (' + row.recommended_price + ')' : ''),
                '',
                '--',
                'View all: https://dkinstaweb.com/admin'
              ],
              row.email
            )
          );
        }

        return json({ ok: true });
      } catch (err) {
        return json({ error: 'Server error.' }, 500);
      }
    }

    /* ---- Admin auth ---- */
    if (path === '/admin/login' && request.method === 'POST') {
      const form = await request.formData();
      const password = String(form.get('password') || '');
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return html(loginPage('Incorrect password.'), 401);
      }
      const token = await sessionToken(env);
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/admin',
          'Set-Cookie':
            SESSION_COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800'
        }
      });
    }

    if (path === '/admin/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/admin',
          'Set-Cookie': SESSION_COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
        }
      });
    }

    /* ---- Admin actions ---- */
    if ((path === '/admin/status' || path === '/admin/delete') && request.method === 'POST') {
      if (!(await isAuthed(request, env))) return html(loginPage(null), 401);
      await ensureSchema(env);
      const form = await request.formData();
      const id = parseInt(String(form.get('id') || ''), 10);
      if (Number.isFinite(id)) {
        if (path === '/admin/delete') {
          await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
        } else {
          const status = String(form.get('status') || 'read').slice(0, 20);
          await env.DB.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind(status, id).run();
        }
      }
      return new Response(null, { status: 302, headers: { Location: '/admin' } });
    }

    /* ---- Admin console ---- */
    if (path === '/admin' || path === '/admin/') {
      if (!(await isAuthed(request, env))) return html(loginPage(null));
      await ensureSchema(env);
      const { results } = await env.DB.prepare(
        'SELECT * FROM submissions ORDER BY created_at DESC LIMIT 500'
      ).all();
      return html(adminPage(results || []));
    }

    /* ---- Static site ---- */
    return env.ASSETS.fetch(request);
  }
};
