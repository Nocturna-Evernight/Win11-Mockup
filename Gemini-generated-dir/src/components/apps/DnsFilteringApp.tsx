import React, { useEffect, useRef, useState } from 'react';
import { Activity, CircleAlert, CircleCheck, Moon, Plus, ShieldCheck, Sun, Trash2 } from 'lucide-react';
import './DnsFilteringApp.css';

interface DnsStats {
  total_queries: number;
  blocked_queries: number;
  allowed_queries: number;
  failed_queries: number;
  cached_entries: number;
  psram_used_bytes: number;
  psram_free_bytes: number;
  uptime_ms: number;
  running: boolean;
  enabled: boolean;
  log_queries: boolean;
  port: number;
  upstream_dns: string;
  last_error?: string;
}

interface DnsRule {
  domain: string;
  blocked: boolean;
  hit_count: number;
  regex: boolean;
}

interface DnsLogEntry {
  timestamp_ms: number;
  domain: string;
  client_ip: string;
  status: 'allowed' | 'blocked' | 'failed';
}

interface DnsAnalytics {
  allowed: number;
  blocked: number;
  failed: number;
  sample_size: number;
  history_source: string;
  timeline: Array<{
    hour: number;
    allowed: number;
    blocked: number;
    failed: number;
  }>;
  top_queries: Array<{ domain: string; count: number }>;
  top_clients: Array<{ client_ip: string; count: number }>;
}

type RuleFilter = 'all' | 'blocked' | 'allowed';

const EMPTY_STATS: DnsStats = {
  total_queries: 0,
  blocked_queries: 0,
  allowed_queries: 0,
  failed_queries: 0,
  cached_entries: 0,
  psram_used_bytes: 0,
  psram_free_bytes: 0,
  uptime_ms: 0,
  running: false,
  enabled: false,
  log_queries: true,
  port: 53,
  upstream_dns: '8.8.8.8',
};

const EMPTY_ANALYTICS: DnsAnalytics = {
  allowed: 0,
  blocked: 0,
  failed: 0,
  sample_size: 0,
  history_source: 'DNS history is stored on internal LittleFS.',
  timeline: [],
  top_queries: [],
  top_clients: [],
};

const RULE_PAGE_SIZE = 40;
const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;

const getUtc8Date = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

const shiftDate = (date: string, days: number) => {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
};

export const DnsFilteringApp: React.FC = () => {
  const [stats, setStats] = useState(EMPTY_STATS);
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(getUtc8Date);
  const [configDraft, setConfigDraft] = useState({
    enabled: EMPTY_STATS.enabled,
    log_queries: EMPTY_STATS.log_queries,
    port: EMPTY_STATS.port,
    upstream_dns: EMPTY_STATS.upstream_dns,
  });
  const configDirtyRef = useRef(false);
  const [rules, setRules] = useState<DnsRule[]>([]);
  const [rulesTotal, setRulesTotal] = useState(0);
  const [ruleFilter, setRuleFilter] = useState<RuleFilter>('all');
  const [ruleOffset, setRuleOffset] = useState(0);
  const [logs, setLogs] = useState<DnsLogEntry[]>([]);
  const [analytics, setAnalytics] = useState(EMPTY_ANALYTICS);
  const [domain, setDomain] = useState('');
  const [ruleAction, setRuleAction] = useState<'block' | 'allow'>('block');
  const [regexRule, setRegexRule] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem('dns-adblock-theme') === 'dark',
  );

  useEffect(() => {
    localStorage.setItem('dns-adblock-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const refreshLive = async () => {
    try {
      const statsResponse = await fetch('/api/dns/stats', { cache: 'no-store' });
      if (!statsResponse.ok) throw new Error('DNS service is unavailable.');
      const nextStats = { ...EMPTY_STATS, ...await statsResponse.json() } as DnsStats;
      setStats(nextStats);
      if (!configDirtyRef.current) {
        setConfigDraft({
          enabled: nextStats.enabled,
          log_queries: nextStats.log_queries,
          port: nextStats.port,
          upstream_dns: nextStats.upstream_dns,
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'DNS service is unavailable.');
    }
  };

  const refreshHistory = async (date: string) => {
    try {
      const query = new URLSearchParams({ date });
      const [logsResponse, analyticsResponse] = await Promise.all([
        fetch(`/api/dns/log?${query}`, { cache: 'no-store' }),
        fetch(`/api/dns/analytics?${query}`, { cache: 'no-store' }),
      ]);
      if (!logsResponse.ok || !analyticsResponse.ok) {
        throw new Error(`Could not load DNS history for ${date}.`);
      }
      const logData = await logsResponse.json();
      const analyticsData = { ...EMPTY_ANALYTICS, ...await analyticsResponse.json() } as DnsAnalytics;
      setLogs(Array.isArray(logData.entries) ? logData.entries : []);
      setAnalytics(analyticsData);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not load DNS history for ${date}.`);
    }
  };

  const refreshRules = async () => {
    try {
      const query = new URLSearchParams({ offset: String(ruleOffset) });
      if (ruleFilter !== 'all') query.set('blocked', String(ruleFilter === 'blocked'));
      const response = await fetch(`/api/dns/domains?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load DNS rules.');
      const data = await response.json();
      setRules(Array.isArray(data.rules) ? data.rules : []);
      setRulesTotal(Number(data.total) || 0);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load DNS rules.');
    }
  };

  useEffect(() => {
    void refreshLive();
    void refreshRules();
    const liveTimer = window.setInterval(() => void refreshLive(), 2500);
    const rulesTimer = window.setInterval(() => void refreshRules(), 10000);
    return () => {
      window.clearInterval(liveTimer);
      window.clearInterval(rulesTimer);
    };
  }, [ruleFilter, ruleOffset]);

  const todayUtc8Date = getUtc8Date();

  useEffect(() => {
    void refreshHistory(selectedHistoryDate);
    if (selectedHistoryDate !== todayUtc8Date) return;
    const historyTimer = window.setInterval(() => void refreshHistory(selectedHistoryDate), 2500);
    return () => window.clearInterval(historyTimer);
  }, [selectedHistoryDate, todayUtc8Date]);

  const postAdminJSON = async (path: string, body: unknown) => {
    const password = window.prompt('Administrator password');
    if (!password) throw new Error('Administrator password is required.');
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
  };

  const saveConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await postAdminJSON('/api/dns/config', {
        enabled: configDraft.enabled,
        upstream_dns: configDraft.upstream_dns,
        port: configDraft.port,
        log_queries: configDraft.log_queries,
      });
      configDirtyRef.current = false;
      setNotice('DNS configuration saved to internal flash.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save DNS configuration.');
    } finally {
      setBusy(false);
      void refreshLive();
    }
  };

  const addRule = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await postAdminJSON('/api/dns/domains', {
        domain: domain.trim(),
        blocked: ruleAction === 'block',
        regex: regexRule,
      });
      setNotice(`${regexRule ? 'Regex' : 'Domain'} rule saved to internal flash.`);
      setDomain('');
      setRegexRule(false);
      setRuleOffset(0);
      void refreshRules();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save DNS rule.');
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (ruleDomain: string, regex: boolean) => {
    setBusy(true);
    try {
      await postAdminJSON('/api/dns/domains', { domain: ruleDomain, regex, remove: true });
      setNotice(`${ruleDomain} removed from the internal rule list.`);
      void refreshRules();
      void refreshLive();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove DNS rule.');
    } finally {
      setBusy(false);
    }
  };

  const maxRequests = Math.max(1, ...analytics.timeline.map((sample) => sample.allowed + sample.blocked + sample.failed));
  const toPoints = (field: 'allowed' | 'blocked' | 'failed') => analytics.timeline.map((sample, index) => {
    const x = analytics.timeline.length < 2 ? CHART_WIDTH : (index / (analytics.timeline.length - 1)) * CHART_WIDTH;
    const y = CHART_HEIGHT - (sample[field] / maxRequests) * (CHART_HEIGHT - 8) - 4;
    return `${x},${y}`;
  }).join(' ');
  const outcomeTotal = analytics.allowed + analytics.blocked + analytics.failed;
  const allowedStop = outcomeTotal ? (analytics.allowed / outcomeTotal) * 100 : 0;
  const blockedStop = outcomeTotal ? ((analytics.allowed + analytics.blocked) / outcomeTotal) * 100 : 0;
  const outcomePieStyle = outcomeTotal
    ? { background: `conic-gradient(#176d68 0% ${allowedStop}%, #df8056 ${allowedStop}% ${blockedStop}%, #8b7bb8 ${blockedStop}% 100%)` }
    : { background: 'conic-gradient(#d7e1df 0% 100%)' };
  const maxTopQueries = Math.max(1, ...analytics.top_queries.map((query) => query.count));
  const maxTopClients = Math.max(1, ...analytics.top_clients.map((client) => client.count));
  const blockRate = stats.total_queries
    ? ((stats.blocked_queries / stats.total_queries) * 100).toFixed(1)
    : '0.0';
  const pageStart = rulesTotal === 0 ? 0 : ruleOffset + 1;
  const pageEnd = Math.min(ruleOffset + RULE_PAGE_SIZE, rulesTotal);

  return (
    <main className={`dns-filtering-app h-full overflow-auto bg-[#f3f6f3] p-5 text-[#18343a] sm:p-7 ${darkMode ? 'dns-filtering-app-dark' : ''}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#cfdbd7] pb-5">
        <div>
          <p className="text-[10px] font-bold tracking-[0.18em] text-[#176d68]">NETWORK SERVICE</p>
          <h2 className="mt-1 text-2xl font-semibold">DNS protection</h2>
          <p className="mt-1 text-xs text-[#62777b]">Live DNS activity, domain rules, and resolver health.</p>
          {!stats.running && stats.last_error && <p className="mt-2 text-xs text-rose-700">{stats.last_error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDarkMode((current) => !current)} aria-pressed={darkMode} className="inline-flex min-h-9 items-center gap-2 border border-[#aebfbb] bg-white px-3 text-xs font-semibold text-[#18343a]">
            {darkMode ? <Sun size={14} /> : <Moon size={14} />}
            {darkMode ? 'Light mode' : 'Dark mode'}
          </button>
          <div className={`inline-flex items-center gap-2 border px-3 py-2 text-xs ${stats.running ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-rose-300 bg-rose-50 text-rose-800'}`}>
            {stats.running ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
            {stats.running ? (stats.enabled ? 'Blocking enabled' : 'Resolver running') : 'Resolver stopped'}
          </div>
        </div>
      </header>

      <section className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div className="border border-[#d5dfdc] border-l-4 border-l-[#176d68] bg-white p-3"><span className="text-[11px] text-[#62777b]">Total queries</span><strong className="mt-1 block text-2xl tabular-nums">{stats.total_queries}</strong></div>
        <div className="border border-[#d5dfdc] border-l-4 border-l-[#df8056] bg-white p-3"><span className="text-[11px] text-[#62777b]">Blocked</span><strong className="mt-1 block text-2xl tabular-nums">{stats.blocked_queries}</strong></div>
        <div className="border border-[#d5dfdc] border-l-4 border-l-[#548998] bg-white p-3"><span className="text-[11px] text-[#62777b]">Allowed</span><strong className="mt-1 block text-2xl tabular-nums">{stats.allowed_queries}</strong></div>
        <div className="border border-[#d5dfdc] border-l-4 border-l-rose-400 bg-white p-3"><span className="text-[11px] text-[#62777b]">Resolver errors</span><strong className="mt-1 block text-2xl tabular-nums">{stats.failed_queries}</strong></div>
        <div className="col-span-2 border border-[#d5dfdc] border-l-4 border-l-[#7181a0] bg-white p-3 sm:col-span-1"><span className="text-[11px] text-[#62777b]">Block rate</span><strong className="mt-1 block text-2xl tabular-nums">{blockRate}%</strong></div>
      </section>

      <section className="mt-5 grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <div className="min-w-0 border border-[#d5dfdc] bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div><h3 className="text-sm font-semibold">Query history</h3><p className="mt-1 text-[11px] text-[#62777b]">Hourly totals for the selected UTC+8 day</p></div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-[#718487]">{analytics.sample_size} logged requests on this day</span>
              <button
                type="button"
                onClick={() => setSelectedHistoryDate((date) => shiftDate(date, -1))}
                aria-label="Show previous day"
                className="border border-[#aebfbb] bg-white px-2 py-1 text-xs font-semibold text-[#18343a]"
              >
                Previous
              </button>
              <input
                type="date"
                value={selectedHistoryDate}
                max={todayUtc8Date}
                onChange={(event) => setSelectedHistoryDate(event.target.value || todayUtc8Date)}
                aria-label="DNS history date"
                className="border border-[#aebfbb] bg-white px-2 py-1 text-xs text-[#18343a]"
              />
              <button
                type="button"
                onClick={() => setSelectedHistoryDate((date) => shiftDate(date, 1))}
                disabled={selectedHistoryDate >= todayUtc8Date}
                aria-label="Show next day"
                className="border border-[#aebfbb] bg-white px-2 py-1 text-xs font-semibold text-[#18343a] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + 24}`} role="img" aria-label={`Allowed, blocked, and failed DNS queries on ${selectedHistoryDate}`} className="mt-3 h-36 w-full">
            {[0, 1, 2, 3].map((line) => {
              const y = (line / 3) * CHART_HEIGHT;
              return <line key={line} x1="0" x2={CHART_WIDTH} y1={y} y2={y} stroke="#e6eeeb" strokeWidth="1" />;
            })}
            {analytics.timeline.length > 1 && <polyline points={toPoints('allowed')} fill="none" stroke="#176d68" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
            {analytics.timeline.length > 1 && <polyline points={toPoints('blocked')} fill="none" stroke="#df8056" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
            {analytics.timeline.length > 1 && <polyline points={toPoints('failed')} fill="none" stroke="#8b7bb8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
            {analytics.timeline.length <= 1 && <text x="50%" y="55%" textAnchor="middle" fill="#718487" fontSize="12">Waiting for logged DNS queries…</text>}
            {analytics.timeline.map((point, index) => (index % 3 === 0 || index === analytics.timeline.length - 1) && (
              <text key={point.hour} x={(index / Math.max(analytics.timeline.length - 1, 1)) * CHART_WIDTH} y={CHART_HEIGHT + 18} textAnchor="middle" fill="#718487" fontSize="9">{String(point.hour).padStart(2, '0')}:00</text>
            ))}
          </svg>
          <div className="flex flex-wrap gap-4 text-[10px] text-[#62777b]">
            <span className="text-[#176d68]">● Allowed</span><span className="text-[#df8056]">● Blocked</span><span className="text-[#8b7bb8]">● Failed</span>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[#718487]">{analytics.history_source}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="border border-[#d5dfdc] bg-white p-4">
            <h3 className="text-sm font-semibold">Query outcomes</h3>
            <div className="mt-3 flex items-center justify-center gap-5">
              <div className="relative h-28 w-28 shrink-0 rounded-full" style={outcomePieStyle} role="img" aria-label={`Query outcomes: ${analytics.allowed} allowed, ${analytics.blocked} blocked, ${analytics.failed} failed`}>
                <div className="absolute inset-6 rounded-full bg-white" />
              </div>
              <ul className="grid gap-2 text-[11px] text-[#62777b]">
                <li><span className="mr-2 text-[#176d68]">●</span>Allowed <strong className="ml-1 tabular-nums text-[#18343a]">{analytics.allowed}</strong></li>
                <li><span className="mr-2 text-[#df8056]">●</span>Blocked <strong className="ml-1 tabular-nums text-[#18343a]">{analytics.blocked}</strong></li>
                <li><span className="mr-2 text-[#8b7bb8]">●</span>Failed <strong className="ml-1 tabular-nums text-[#18343a]">{analytics.failed}</strong></li>
              </ul>
            </div>
          </div>
          <div className="border border-[#d5dfdc] bg-white p-4">
            <h3 className="text-sm font-semibold">Top queried domains</h3>
            <p className="mt-1 text-[10px] text-[#718487]">Counted from the newest logged requests</p>
            {analytics.top_queries.length === 0 ? <p className="mt-4 text-xs text-[#62777b]">No logged requests yet.</p> : (
              <ol className="mt-3 grid gap-2.5">
                {analytics.top_queries.map((query) => (
                  <li key={query.domain}>
                    <div className="flex justify-between gap-2 text-[11px]"><span className="truncate">{query.domain}</span><strong className="tabular-nums">{query.count}</strong></div>
                    <div className="mt-1 h-1 overflow-hidden rounded bg-[#e6edeb]"><div className="h-full bg-[#176d68]" style={{ width: `${Math.max(2, (query.count / maxTopQueries) * 100)}%` }} /></div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="border border-[#d5dfdc] bg-white p-4">
            <h3 className="text-sm font-semibold">Top clients</h3>
            <p className="mt-1 text-[10px] text-[#718487]">Clients with the most recent requests</p>
            {analytics.top_clients.length === 0 ? <p className="mt-4 text-xs text-[#62777b]">No logged clients yet.</p> : (
              <ol className="mt-3 grid gap-2.5">
                {analytics.top_clients.map((client) => (
                  <li key={client.client_ip}>
                    <div className="flex justify-between gap-2 text-[11px]"><span>{client.client_ip}</span><strong className="tabular-nums">{client.count}</strong></div>
                    <div className="mt-1 h-1 overflow-hidden rounded bg-[#e6edeb]"><div className="h-full bg-[#7181a0]" style={{ width: `${Math.max(2, (client.count / maxTopClients) * 100)}%` }} /></div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </section>

      <section className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="border border-[#d5dfdc] bg-white p-3"><span className="text-[11px] text-[#62777b]">Rules loaded</span><strong className="mt-1 block text-lg tabular-nums">{stats.cached_entries}</strong></div>
        <div className="border border-[#d5dfdc] bg-white p-3"><span className="text-[11px] text-[#62777b]">Rule cache memory</span><strong className="mt-1 block text-lg tabular-nums">{(stats.psram_used_bytes / 1024).toFixed(1)} KB</strong><span className="text-[10px] text-[#718487]">{(stats.psram_free_bytes / (1024 * 1024)).toFixed(1)} MB PSRAM free</span></div>
      </section>

      <form onSubmit={saveConfig} className="mt-6 border-t border-[#cfdbd7] pt-5">
        <div className="flex items-center gap-2 text-sm font-semibold"><Activity size={16} className="text-[#176d68]" /> Resolver configuration</div>
        <label className="mt-4 flex items-center gap-3 text-sm">
          <input type="checkbox" checked={configDraft.enabled} onChange={(event) => { configDirtyRef.current = true; setConfigDraft({ ...configDraft, enabled: event.target.checked }); }} className="h-4 w-4 accent-[#176d68]" />
          Enable domain blocking
        </label>
        <label className="mt-3 flex items-center gap-3 text-sm">
          <input type="checkbox" checked={configDraft.log_queries} onChange={(event) => { configDirtyRef.current = true; setConfigDraft({ ...configDraft, log_queries: event.target.checked }); }} className="h-4 w-4 accent-[#176d68]" />
          Log DNS requests in the live activity view
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block text-xs font-semibold text-[#62777b]">Upstream IPv4 resolver
            <input value={configDraft.upstream_dns} onChange={(event) => { configDirtyRef.current = true; setConfigDraft({ ...configDraft, upstream_dns: event.target.value }); }} inputMode="decimal" required className="mt-1 block min-h-10 w-full border border-[#bdcdca] bg-white px-3 text-sm font-normal text-[#18343a]" />
          </label>
          <button disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-2 bg-[#176d68] px-4 text-xs font-semibold text-white disabled:opacity-50"><ShieldCheck size={15} /> Save configuration</button>
        </div>
      </form>

      <form onSubmit={addRule} className="mt-6 border-t border-[#cfdbd7] pt-5">
        <div className="text-sm font-semibold">Add a domain or regex rule</div>
        <p className="mt-1 text-xs leading-relaxed text-[#62777b]">Literal entries match a domain and its subdomains. Regex rules use case-insensitive POSIX extended syntax; literal rules take precedence over regex rules.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_120px_auto_auto]">
          <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={regexRule ? '^(ads|tracker)[0-9]*\\.example\\.com$' : 'ads.example.com'} required className="min-h-10 border border-[#bdcdca] bg-white px-3 text-sm" />
          <select value={ruleAction} onChange={(event) => setRuleAction(event.target.value as 'block' | 'allow')} className="min-h-10 border border-[#bdcdca] bg-white px-3 text-sm"><option value="block">Block</option><option value="allow">Allow</option></select>
          <label className="flex min-h-10 items-center gap-2 whitespace-nowrap border border-[#bdcdca] bg-white px-3 text-xs"><input type="checkbox" checked={regexRule} onChange={(event) => setRegexRule(event.target.checked)} className="h-4 w-4 accent-[#176d68]" /> Regex</label>
          <button disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-2 border border-[#aebfbb] bg-white px-4 text-xs font-semibold text-[#18343a] disabled:opacity-50"><Plus size={15} /> Add rule</button>
        </div>
      </form>

      <section className="mt-6 border-t border-[#cfdbd7] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Domain rules</h3>
          <span className="text-[11px] text-[#62777b]">{rulesTotal} matching persistent rules</span>
        </div>
        <div className="mt-3 flex gap-1 border-b border-[#d5dfdc]">
          {(['all', 'blocked', 'allowed'] as const).map((filter) => (
            <button key={filter} type="button" onClick={() => { setRuleOffset(0); setRuleFilter(filter); }} className={`border-b-2 px-3 py-2 text-xs font-semibold capitalize ${ruleFilter === filter ? 'border-[#176d68] text-[#176d68]' : 'border-transparent text-[#718487]'}`}>
              {filter === 'all' ? 'All rules' : `${filter} rules`}
            </button>
          ))}
        </div>
        <div className="divide-y divide-[#d5dfdc] border-b border-[#d5dfdc] bg-white">
          {rules.length === 0 ? (
            <p className="px-3 py-4 text-xs text-[#62777b]">No {ruleFilter === 'all' ? '' : `${ruleFilter} `}rules found.</p>
          ) : rules.map((rule) => (
            <div key={`${rule.regex ? 'regex' : 'domain'}-${rule.domain}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium">{rule.regex ? '↳ ' : ''}{rule.domain}</span>
                <span className="text-[10px] text-[#62777b]">{rule.regex ? 'Regex' : 'Domain'} · {rule.blocked ? 'Blocked' : 'Allowed'} · {rule.hit_count} matched queries</span>
              </div>
              <button type="button" title={`Remove ${rule.domain}`} disabled={busy} onClick={() => void removeRule(rule.domain, rule.regex)} className="inline-flex min-h-8 items-center gap-1 border border-[#d5dfdc] px-2 text-[11px] text-[#62777b] hover:border-rose-400 hover:text-rose-700 disabled:opacity-50"><Trash2 size={13} /> Remove</button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between pt-2 text-[11px] text-[#62777b]">
          <span>{pageStart}-{pageEnd} of {rulesTotal}</span>
          <div className="flex gap-2">
            <button type="button" disabled={ruleOffset === 0} onClick={() => setRuleOffset(Math.max(0, ruleOffset - RULE_PAGE_SIZE))} className="border border-[#bdcdca] px-2 py-1 disabled:opacity-40">Previous</button>
            <button type="button" disabled={ruleOffset + RULE_PAGE_SIZE >= rulesTotal} onClick={() => setRuleOffset(ruleOffset + RULE_PAGE_SIZE)} className="border border-[#bdcdca] px-2 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>

      <section className="mt-6 border-t border-[#cfdbd7] pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <div><h3 className="text-sm font-semibold">Live request log</h3><p className="mt-1 text-[11px] text-[#62777b]">Latest {logs.length} DNS requests · refreshes every 2.5 seconds</p></div>
          <span className={`text-[10px] ${stats.log_queries ? 'text-emerald-700' : 'text-amber-700'}`}>{stats.log_queries ? 'Logging on' : 'Logging disabled'}</span>
        </div>
        <div className="mt-3 max-h-72 overflow-auto border border-[#d5dfdc] bg-white">
          {logs.length === 0 ? <p className="px-3 py-5 text-xs text-[#62777b]">{stats.log_queries ? 'No DNS requests logged yet.' : 'Turn on query logging to view live requests.'}</p> : logs.map((entry, index) => {
            const ageMs = Math.max(0, entry.timestamp_ms > 1_000_000_000_000
              ? Date.now() - entry.timestamp_ms
              : stats.uptime_ms - entry.timestamp_ms);
            const age = ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s ago` : `${Math.floor(ageMs / 60000)}m ago`;
            const badge = entry.status === 'blocked'
              ? 'bg-rose-50 text-rose-700'
              : entry.status === 'failed' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800';
            return (
              <div key={`${entry.timestamp_ms}-${entry.domain}-${index}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-[#edf1ef] px-3 py-2 last:border-b-0">
                <span className={`min-w-16 px-2 py-1 text-center text-[9px] font-bold uppercase ${badge}`}>{entry.status}</span>
                <div className="min-w-0"><span className="block truncate text-xs font-medium">{entry.domain}</span><span className="text-[10px] text-[#718487]">Client {entry.client_ip}</span></div>
                <span className="text-[10px] tabular-nums text-[#718487]">{age}</span>
              </div>
            );
          })}
        </div>
      </section>

      <p role="status" className="mt-4 min-h-5 text-xs text-[#176d68]">{notice || `UDP ${stats.port} · upstream ${stats.upstream_dns}`}</p>
      {stats.last_error && <p className="mt-1 text-xs text-rose-700">Latest DNS error: {stats.last_error}</p>}
      <p className="mt-2 border-t border-[#cfdbd7] pt-3 text-[11px] leading-relaxed text-[#62777b]">Clients must use this device as their DNS server to benefit from filtering. Router DHCP settings may be needed for network-wide coverage.</p>
    </main>
  );
};
