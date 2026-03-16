import express from 'express';

const app = express();
app.use(express.json());

// ─── Credentials ──────────────────────────────────────────────────────────────
const BASIC_AUTH = process.env.TS_BASIC_AUTH || 'MDRmNzEyZmUtNjk0MS00MDgyLTg4NWUtMzBmYzAwZjAwZDM4Ojc0MzRhM2IzLWExYzgtNGIxYi1hNjEzLTMyNTU3MDBjMWU2Ng==';
const TS_USERNAME = process.env.TS_USERNAME || 'bfbotn8n';
const TS_PASSWORD = process.env.TS_PASSWORD || 'uqBcCKj29g@f1';
const ACCOUNT = process.env.TS_ACCOUNT || '0742559388-00001';
const BASE = 'https://thingspace.verizon.com/api/m2m/v1';

// ─── Token Cache ──────────────────────────────────────────────────────────────
let oauthToken = null, oauthExpiry = 0;
let sessionToken = null, sessionExpiry = 0;

async function getOAuth() {
  if (oauthToken && Date.now() < oauthExpiry - 30000) return oauthToken;
  const res = await fetch('https://thingspace.verizon.com/api/ts/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${BASIC_AUTH}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`OAuth failed: ${JSON.stringify(d)}`);
  oauthToken = d.access_token;
  oauthExpiry = Date.now() + d.expires_in * 1000;
  return oauthToken;
}

async function getSession() {
  if (sessionToken && Date.now() < sessionExpiry - 30000) return sessionToken;
  const oauth = await getOAuth();
  const res = await fetch(`${BASE}/session/login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${oauth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TS_USERNAME, password: TS_PASSWORD })
  });
  const d = await res.json();
  if (!d.sessionToken) throw new Error(`Session login failed: ${JSON.stringify(d)}`);
  sessionToken = d.sessionToken;
  sessionExpiry = Date.now() + 14 * 60 * 1000;
  return sessionToken;
}

async function tsHeaders() {
  const [oauth, session] = await Promise.all([getOAuth(), getSession()]);
  return { Authorization: `Bearer ${oauth}`, 'VZ-M2M-Token': session, 'Content-Type': 'application/json' };
}

async function tsGet(path) {
  const h = await tsHeaders();
  const r = await fetch(`${BASE}${path}`, { headers: h });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}

async function tsPost(path, body) {
  const h = await tsHeaders();
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}

// Build deviceList for action endpoints
function deviceList(deviceId) {
  const clean = deviceId.replace(/\D/g, '');
  let kind = 'imei';
  if (clean.length >= 19) kind = 'iccid';
  else if (clean.length === 10) kind = 'mdn';
  return [{ deviceIds: [{ id: clean, kind }] }];
}

// ─── MCP Tools ────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_account_info',
    description: 'Get Nomad Internet ThingSpace account details, service plans, and IP pools',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_devices',
    description: 'List devices on the account. Filter by deviceId (IMEI/MDN/ICCID), status, or custom field. Returns device IDs, status, connection state, and custom fields (including ICCID stored in CustomField2).',
    inputSchema: {
      type: 'object',
      properties: {
        imei: { type: 'string', description: 'Filter by IMEI (15 digits)' },
        mdn: { type: 'string', description: 'Filter by MDN/phone number (10 digits)' },
        iccid: { type: 'string', description: 'Filter by ICCID (19-20 digits)' },
        status: { type: 'string', description: 'Filter by state: active, suspended, deactivated' },
        maxResults: { type: 'number', description: 'Max devices to return (default 10, max 100)' },
        startIndex: { type: 'string', description: 'Pagination: continuation token from lastSeenDeviceId' }
      }
    }
  },
  {
    name: 'get_device_details',
    description: 'Get full details for a specific device by IMEI, MDN, or ICCID',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device IMEI (15 digits), MDN (10 digits), or ICCID (19-20 digits)' } },
      required: ['deviceId']
    }
  },
  {
    name: 'get_usage',
    description: 'Get data usage statistics for a device over a date range',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' },
        startDate: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago)' },
        endDate: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'suspend_line',
    description: 'Suspend cellular service for a device. REVERSIBLE via resume_line. Use for non-payment or temporary hold.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' },
        reason: { type: 'string', description: 'Reason code: TP-Loss, TP-Stolen, etc.' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'resume_line',
    description: 'Resume service for a SUSPENDED device. Reconnects within 1-5 minutes.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' } },
      required: ['deviceId']
    }
  },
  {
    name: 'activate_device',
    description: 'Activate a provisioned device. Requires servicePlan.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' },
        servicePlan: { type: 'string', description: 'Service plan name/code to activate on' }
      },
      required: ['deviceId', 'servicePlan']
    }
  },
  {
    name: 'deactivate_line',
    description: '⚠️ PERMANENT deactivation (cancellation). Use suspend_line for temporary holds.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' },
        reason: { type: 'string', description: 'Reason for deactivation' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_diagnostics',
    description: 'Get extended diagnostics for a device',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device IMEI, MDN, or ICCID' } },
      required: ['deviceId']
    }
  }
];

// ─── Handlers ─────────────────────────────────────────────────────────────────
async function handle(name, args) {
  switch (name) {

    case 'get_account_info': {
      const r = await tsGet(`/accounts/${ACCOUNT}`);
      if (r.status !== 200) return { success: false, status: r.status, error: r.data };
      const a = r.data;
      return {
        success: true,
        accountName: a.accountName,
        organizationName: a.organizationName,
        isProvisioningAllowed: a.isProvisioningAllowed,
        carriers: a.carriers,
        servicePlansCount: a.servicePlans?.length || 0,
        ipPools: a.ipPools,
        features: a.features
      };
    }

    case 'list_devices': {
      const body = {
        accountName: ACCOUNT,
        maxResults: args.maxResults || 10
      };
      if (args.startIndex) body.lastSeenDeviceId = args.startIndex;

      // Build filter
      const filter = {};
      if (args.status) filter.deviceState = args.status;
      if (Object.keys(filter).length) body.filter = filter;

      // If searching by specific ID, list and filter client-side
      const r = await tsPost('/devices/actions/list', body);
      if (r.status !== 200) return { success: false, status: r.status, error: r.data };

      let devices = r.data.devices || [];

      // Client-side filter by ID type
      if (args.imei) {
        devices = devices.filter(d => d.deviceIds?.some(x => x.kind === 'imei' && x.id === args.imei));
      }
      if (args.mdn) {
        devices = devices.filter(d => d.deviceIds?.some(x => x.kind === 'mdn' && x.id === args.mdn));
      }
      if (args.iccid) {
        devices = devices.filter(d =>
          d.deviceIds?.some(x => x.kind === 'iccid' && x.id.includes(args.iccid)) ||
          d.customFields?.some(f => f.key === 'CustomField2' && f.value?.includes(args.iccid))
        );
      }

      return {
        success: true,
        hasMoreData: r.data.hasMoreData,
        count: devices.length,
        devices: devices.map(d => ({
          imei: d.deviceIds?.find(x => x.kind === 'imei')?.id,
          mdn: d.deviceIds?.find(x => x.kind === 'mdn')?.id,
          iccid: d.deviceIds?.find(x => x.kind === 'iccId' || x.kind === 'iccid')?.id,
          imsi: d.deviceIds?.find(x => x.kind === 'imsi')?.id,
          state: d.carrierInformations?.[0]?.state,
          connected: d.connected,
          servicePlan: d.carrierInformations?.[0]?.servicePlan,
          customFields: d.customFields,
          createdAt: d.createdAt,
          billingCycleEnd: d.billingCycleEndDate
        }))
      };
    }

    case 'get_device_details': {
      // List all devices and find the one matching the ID
      const clean = args.deviceId.replace(/\D/g, '');
      let kind = 'imei';
      if (clean.length >= 19) kind = 'iccid';
      else if (clean.length === 10) kind = 'mdn';

      // Page through devices to find matching one
      let body = { accountName: ACCOUNT, maxResults: 100 };
      let found = null;
      let hasMore = true;
      let lastSeen = null;

      while (hasMore && !found) {
        if (lastSeen) body.lastSeenDeviceId = lastSeen;
        const r = await tsPost('/devices/actions/list', body);
        if (r.status !== 200) return { success: false, status: r.status, error: r.data };
        const devices = r.data.devices || [];
        found = devices.find(d => d.deviceIds?.some(x =>
          (x.kind === kind || x.kind === 'iccId') && x.id.includes(clean)
        ));
        hasMore = r.data.hasMoreData;
        lastSeen = devices[devices.length - 1]?.deviceIds?.[0]?.id;
        if (devices.length === 0) break;
      }

      if (!found) return { success: false, error: `Device ${args.deviceId} not found` };
      return { success: true, device: found };
    }

    case 'get_usage': {
      const end = args.endDate || new Date().toISOString().split('T')[0];
      const start = args.startDate || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
      const body = {
        accountName: ACCOUNT,
        deviceList: deviceList(args.deviceId),
        startTime: `${start}T00:00:00Z`,
        endTime: `${end}T23:59:59Z`
      };
      const r = await tsPost('/devices/usage/actions/list', body);
      if (r.status !== 200) return { success: false, status: r.status, error: r.data };
      return { success: true, period: { start, end }, deviceId: args.deviceId, usage: r.data };
    }

    case 'suspend_line': {
      const body = {
        accountName: ACCOUNT,
        deviceList: deviceList(args.deviceId),
        ...(args.reason ? { reasonCode: args.reason } : {})
      };
      const r = await tsPost('/devices/actions/suspend', body);
      return { success: r.status < 300, status: r.status, deviceId: args.deviceId, result: r.data };
    }

    case 'resume_line': {
      const body = { accountName: ACCOUNT, deviceList: deviceList(args.deviceId) };
      const r = await tsPost('/devices/actions/restore', body);
      return { success: r.status < 300, status: r.status, deviceId: args.deviceId, result: r.data };
    }

    case 'activate_device': {
      const body = {
        accountName: ACCOUNT,
        deviceList: deviceList(args.deviceId),
        servicePlan: args.servicePlan,
        mdnZipCode: ''
      };
      const r = await tsPost('/devices/actions/activate', body);
      return { success: r.status < 300, status: r.status, deviceId: args.deviceId, result: r.data };
    }

    case 'deactivate_line': {
      const body = {
        accountName: ACCOUNT,
        deviceList: deviceList(args.deviceId),
        ...(args.reason ? { reasonCode: args.reason } : {})
      };
      const r = await tsPost('/devices/actions/deactivate', body);
      return {
        success: r.status < 300,
        status: r.status,
        deviceId: args.deviceId,
        WARNING: 'PERMANENT — cannot be undone without Verizon CS',
        result: r.data
      };
    }

    case 'get_diagnostics': {
      const body = { accountName: ACCOUNT, deviceList: deviceList(args.deviceId) };
      const r = await tsPost('/devices/diagnostics/actions/retrieval', body);
      return { success: r.status < 300, status: r.status, deviceId: args.deviceId, diagnostics: r.data };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Endpoint ─────────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, method, id, params } = req.body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc, id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'thingspace-mcp', version: '2.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({ jsonrpc, id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await handle(name, args || {});
      return res.json({
        jsonrpc, id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      });
    } catch (err) {
      return res.json({
        jsonrpc, id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }]
        }
      });
    }
  }

  res.status(404).json({ error: 'Method not found' });
});

app.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'thingspace-mcp', version: '2.0.0', account: ACCOUNT })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ThingSpace MCP v2.0 on port ${PORT}`));
