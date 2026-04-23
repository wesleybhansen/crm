# SPEC-062 Phase 3 — External MCP HTTPS endpoint (deferred plan)

**Status:** Scoped but not built — deferred for a dedicated ops-focused session.
**Why deferred:** Needs infrastructure changes (new docker-compose service, nginx config, module enablement) that are safer to do with full attention and a rollback plan than bundled with Phase 2/4 code deploys.

## What's already there

- `packages/ai-assistant/src/modules/ai_assistant/lib/http-server.ts` — full MCP HTTP server with `StreamableHTTPServerTransport`, auth via x-api-key + session tokens, 415 tools registered (10 built-in + 405 auto-discovered from OpenAPI)
- CLI command `mercato ai_assistant mcp:serve-http --port 3001` invokes it
- The HTTP server enforces API-key auth internally
- Session tokens already injected into every tool schema as `_sessionToken`

## What's missing in prod

1. **ai_assistant module is commented out** in `apps/mercato/src/modules.ts` line ~48 (`// { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },`). Without registration, the CLI doesn't discover the `ai_assistant` module and `mcp:serve-http` throws "Module not found".
2. **No docker-compose service starts the MCP server.** Today only the Next.js `app` service runs. MCP HTTP process needs to be launched alongside.
3. **Nginx doesn't route `/mcp`** to anything. Needs a `location` block forwarding to the MCP container.
4. **No DNS / public host** — the CRM is at `crm.thelaunchpadincubator.com`; decide whether to serve MCP under `/mcp` of the same host or a subdomain (`mcp.launchcrm.com`).

## Build steps

### 1. Enable ai_assistant module
Edit `apps/mercato/src/modules.ts`, uncomment the line:
```diff
-  // { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },
+  { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },
```

Verify nothing breaks at build time. Risks:
- New DI registrations may conflict with existing ones
- New subscribers may fire on existing events (side effects)
- New UI widgets may be injected into existing pages

**Mitigation:** Build locally first (`yarn build`), run the existing test suite, check for startup errors.

### 2. Add docker-compose service
Add to `docker-compose.prod.yml`:
```yaml
  mcp:
    image: open-mercato-app
    container_name: launchos-mcp
    restart: unless-stopped
    env_file: .env.production
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://${POSTGRES_USER:-crm}:${POSTGRES_PASSWORD:-crm_prod_2026}@postgres:5432/${POSTGRES_DB:-crm}
    working_dir: /app/apps/mercato
    command: ["node", "/app/packages/cli/bin/mercato", "ai_assistant", "mcp:serve-http", "--port", "3001"]
    depends_on:
      app:
        condition: service_started
      postgres:
        condition: service_healthy
    networks:
      - launchos-network
```

Reuses the same image; runs the CLI command instead of the Next.js server. No port exposure — nginx proxies internally.

### 3. Update nginx.conf
Add a `location /mcp` block inside the existing server:
```nginx
    location /mcp {
        proxy_pass http://mcp:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streamable HTTP transport — keep connections open
        proxy_read_timeout 86400;
        proxy_buffering off;

        # Reject requests without an api key at the edge
        if ($http_x_api_key = "") {
            return 401 '{"error":"x-api-key required"}';
        }
    }
```

### 4. Deploy
```bash
ssh root@5.78.71.144
cd /root/open-mercato
git pull
docker compose -f docker-compose.prod.yml build app    # rebuild to pick up ai_assistant enablement
docker compose -f docker-compose.prod.yml up -d        # starts mcp service, reloads nginx
```

### 5. Smoke test
```bash
# Listing tools via MCP initialize
curl -sS -k -X POST https://crm.thelaunchpadincubator.com/mcp \
  -H "x-api-key: <prod-api-key>" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'
```

Expect: `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":...,"capabilities":{...}}}` with no auth error.

Without x-api-key: 401 from nginx before reaching the app.

### 6. Document for third-party agents

Add `apps/docs/docs/api/mcp-server.mdx`:

- **Endpoint:** `https://crm.thelaunchpadincubator.com/mcp`
- **Auth:** `x-api-key: <api-key>` header on every request
- **Protocol:** MCP streamable HTTP
- **Claude Desktop config:**
  ```json
  {
    "mcpServers": {
      "launchcrm": {
        "command": "npx",
        "args": ["mcp-remote", "https://crm.thelaunchpadincubator.com/mcp"],
        "env": { "X_API_KEY": "<api-key>" }
      }
    }
  }
  ```
- **OpenCode config:** (existing pattern from docker-compose)
- **Tool catalog:** 415 tools — see live listing via `tools/list` RPC

## Risks & rollback

- If the ai_assistant module enablement breaks something: comment the line out, rebuild, redeploy. Rolls back cleanly.
- If the MCP container crashlooops: `docker compose stop mcp` keeps the rest running. Nginx `/mcp` will return 502 but other routes unaffected.
- Nginx config reload: `docker compose exec nginx nginx -s reload`. Reverts via `git checkout nginx.conf && reload`.

## Effort

~30-60 min of hands-on ops work if the ai_assistant enablement is clean. 2-3 hours if side effects need untangling.
