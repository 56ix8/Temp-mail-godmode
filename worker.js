// --- SVARA NETWORK CORE ENGINE ---

function extractPart(raw, type) {
    let idx = raw.indexOf(`Content-Type: ${type}`);
    if (idx === -1) return null;
    let sliced = raw.substring(idx);
    let headerEnd = sliced.indexOf("\r\n\r\n");
    if (headerEnd === -1) headerEnd = sliced.indexOf("\n\n");
    if (headerEnd === -1) return null;
    let body = sliced.substring(headerEnd).trim();
    let nextBound = body.indexOf("\r\n--");
    if (nextBound === -1) nextBound = body.indexOf("\n--");
    if (nextBound !== -1) body = body.substring(0, nextBound);
    
    body = body.replace(/=\r\n/g, "").replace(/=\n/g, "");
    body = body.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
        try { return decodeURIComponent('%' + hex); } catch(e) { 
            try { return String.fromCharCode(parseInt(hex, 16)); } catch(e) { return match; }
        }
    });
    return body;
}

export default {
  async email(message, env, ctx) {
    const recipient = message.to;
    const sender = message.headers.get("from") || message.from;
    const subject = message.headers.get("subject") || "(Tanpa Subjek)";
    const rawEmail = await new Response(message.raw).text();
    
    let cleanText = "Pesan teks tidak tersedia."; let cleanHtml = ""; let attachmentsHtml = ""; 

    try {
        if (rawEmail.includes("multipart/")) {
            cleanText = extractPart(rawEmail, "text/plain") || cleanText; cleanHtml = extractPart(rawEmail, "text/html") || "";
            const boundaryMatch = rawEmail.match(/boundary="?([^"\r\n]+)"?/i);
            if (boundaryMatch) {
                const parts = rawEmail.split("--" + boundaryMatch[1]);
                for (let part of parts) {
                    if (part.includes("Content-Disposition: attachment") || part.includes("Content-Disposition: inline; filename")) {
                        let fnameMatch = part.match(/filename="?([^"\r\n]+)"?/i); let fname = fnameMatch ? fnameMatch[1] : "file.bin";
                        let headerEnd = part.indexOf("\r\n\r\n"); if (headerEnd === -1) headerEnd = part.indexOf("\n\n");
                        if (headerEnd !== -1) {
                            let b64 = part.substring(headerEnd).replace(/\s+/g, "");
                            try {
                                let binString = atob(b64); let bytes = new Uint8Array(binString.length);
                                for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);
                                let fileKey = Date.now() + "_" + fname; await env.BUCKET.put(fileKey, bytes.buffer);
                                attachmentsHtml += `<div style="margin-top:20px; padding:15px; border:1px solid #334155; border-radius:12px; background:#0f172a; color:#f8fafc; font-family:monospace;"><p>📎 <b>${fname}</b></p><a href="https://${env.WORKER_HOST}/api/download/${fileKey}?key=${env.ADMIN_KEY}" target="_blank" style="display:inline-block; padding:8px 16px; background:#06b6d4; color:#030712; text-decoration:none; border-radius:6px; font-weight:bold;">⬇ Download File</a></div>`;
                            } catch(err) {}
                        }
                    }
                }
            }
        } else { let headerEndIdx = rawEmail.indexOf("\r\n\r\n"); cleanText = headerEndIdx !== -1 ? rawEmail.substring(headerEndIdx).trim() : rawEmail; }
        cleanHtml += attachmentsHtml;
    } catch (e) { console.error(e); }

    await env.DB.prepare("INSERT INTO emails (recipient, sender, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?)").bind(recipient, sender, subject, cleanText, cleanHtml).run();
    await env.DB.prepare("DELETE FROM emails WHERE created_at <= datetime('now', '-1 day')").run();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Secret-Key" } });

    const userKey = request.headers.get("X-Secret-Key") || url.searchParams.get("key");
    const validCodes = env.VALID_CLASS_CODES ? env.VALID_CLASS_CODES.split(',') : ["TESTING123"];
    const isMember = validCodes.includes(userKey); 
    const isAdmin = userKey === env.ADMIN_KEY;
    
    if (!isMember && !isAdmin) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });

    if (url.pathname === "/api/send" && request.method === "POST") {
        try {
            const body = await request.json();
            const resendReq = new Request("[https://api.resend.com/emails](https://api.resend.com/emails)", {
                method: "POST", headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ from: `Svara Member <${body.from}>`, to: [body.to], subject: body.subject, html: body.html_content })
            });
            const resendResponse = await fetch(resendReq);
            const resendResult = await resendResponse.json();
            if (!resendResponse.ok) return new Response(JSON.stringify({ error: "Gagal mengirim", detail: JSON.stringify(resendResult) }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });

            await env.DB.prepare("INSERT INTO outbox (sender, recipient, subject) VALUES (?, ?, ?)").bind(body.from, body.to, body.subject).run();
            await env.DB.prepare("DELETE FROM outbox WHERE created_at <= datetime('now', '-1 day')").run();
            return new Response(JSON.stringify({ success: true, message: "Terkirim" }), { headers: { "Access-Control-Allow-Origin": "*" } });
        } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }); }
    }

    if (url.pathname === "/api/admin" && request.method === "GET") {
        if (!isAdmin) return new Response("Akses Ditolak", { status: 403 });
        const { results: inbox } = await env.DB.prepare("SELECT recipient, sender, subject, created_at FROM emails ORDER BY created_at DESC LIMIT 50").all();
        const { results: outbox } = await env.DB.prepare("SELECT sender, recipient, subject, created_at FROM outbox ORDER BY created_at DESC LIMIT 50").all();

        let inboxRows = inbox.map(row => `<tr><td style="padding:10px; border-bottom:1px solid #334155;">${new Date(row.created_at).toLocaleString('id-ID')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#a78bfa;">${row.sender.replace(/[<>]/g, '')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#34d399;">${row.recipient}</td><td style="padding:10px; border-bottom:1px solid #334155;">${row.subject}</td></tr>`).join('');
        let outboxRows = outbox.map(row => `<tr><td style="padding:10px; border-bottom:1px solid #334155;">${new Date(row.created_at).toLocaleString('id-ID')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#34d399;">${row.sender}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#f87171;">${row.recipient}</td><td style="padding:10px; border-bottom:1px solid #334155;">${row.subject}</td></tr>`).join('');

        const adminHtml = `<!DOCTYPE html><html><head><title>Svara Telemetry</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{background-color:#030712; color:#cbd5e1; font-family:monospace; padding:20px;} h1, h2{color:#38bdf8;} table{width:100%; border-collapse:collapse; margin-bottom:40px; background:#0f172a; border-radius:8px; overflow:hidden;} th{background:#1e293b; padding:12px; text-align:left; color:#f8fafc; font-size:14px;} td{font-size:12px; word-break:break-all;}</style></head><body><h1 style="text-align:center; font-size:2em; text-transform:uppercase; letter-spacing:2px; margin-bottom:5px;">OMNISCIENT TELEMETRY</h1><p style="text-align:center; color:#64748b; margin-bottom:40px;">Real-time Ingress & Egress Monitoring</p><h2>⬇️ INGRESS (Incoming)</h2><table><thead><tr><th>Waktu (UTC)</th><th>Pengirim</th><th>Penerima</th><th>Subjek</th></tr></thead><tbody>${inboxRows || '<tr><td colspan="4" style="text-align:center;">N/A</td></tr>'}</tbody></table><h2>⬆️ EGRESS (Outgoing)</h2><table><thead><tr><th>Waktu (UTC)</th><th>Pengirim</th><th>Tujuan</th><th>Subjek</th></tr></thead><tbody>${outboxRows || '<tr><td colspan="4" style="text-align:center;">N/A</td></tr>'}</tbody></table></body></html>`;
        return new Response(adminHtml, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname.startsWith("/api/download/") && request.method === "GET") {
        const fileKey = url.pathname.replace("/api/download/", ""); const object = await env.BUCKET.get(fileKey); 
        if (!object) return new Response("File expired.", { status: 404 });
        const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("Access-Control-Allow-Origin", "*"); headers.set("Content-Disposition", `attachment; filename="${fileKey.substring(14)}"`);
        return new Response(object.body, { headers });
    }

    if (url.pathname === "/api/emails" && request.method === "GET") {
      const address = url.searchParams.get("address"); if (!address) return new Response("Missing address", { status: 400 });
      const { results } = await env.DB.prepare("SELECT * FROM emails WHERE recipient = ? ORDER BY created_at DESC").bind(address).all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    
    return new Response("System Online", { status: 200 });
  }
};
