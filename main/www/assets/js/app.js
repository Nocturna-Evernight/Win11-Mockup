// Win11 WebOS Modern UI JavaScript
class Win11OS {
    constructor() {
        this.currentApp = null;
        this.zIndex = 1500;
        this.dnsRefreshTimer = null;
        this.dnsAdlistUpdateTimer = null;
        this.init();
    }

    init() {
        this.updateTime();
        setInterval(() => this.updateTime(), 60000);
        
        document.getElementById('startBtn').addEventListener('click', () => this.toggleStartMenu());
        document.getElementById('desktop').addEventListener('click', (e) => {
            if (e.target.id === 'desktop' || e.target.id === 'wallpaper') {
                this.hideStartMenu();
            }
        });
        
        document.querySelectorAll('.desktop-icon').forEach(icon => {
            icon.addEventListener('click', () => {
                const app = icon.dataset.app;
                this.openApp(app);
            });
        });
        
        document.querySelectorAll('.start-menu [data-app]').forEach(item => {
            item.addEventListener('click', () => {
                const app = item.dataset.app;
                if (app === 'shutdown') {
                    this.shutdown();
                } else if (app === 'restart') {
                    this.requestPowerAction('/api/system/reboot', 'restart');
                    this.hideStartMenu();
                } else {
                    this.openApp(app);
                    this.hideStartMenu();
                }
            });
        });
        
        // Window controls
        document.getElementById('minBtn').addEventListener('click', () => this.minimizeWindow());
        document.getElementById('maxBtn').addEventListener('click', () => this.maximizeWindow());
        document.getElementById('closeBtn').addEventListener('click', () => this.closeWindow());
        
        // Make window draggable
        const windowHeader = document.querySelector('.window-header');
        windowHeader.addEventListener('mousedown', (e) => this.dragWindow(e));
        
        this.loadWallpaper();
        this.loadCurrentUser();
    }

    updateTime() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
        });
        document.getElementById('taskbarTime').textContent = timeStr;
    }

    toggleStartMenu() {
        const menu = document.getElementById('startMenu');
        menu.classList.toggle('active');
    }

    hideStartMenu() {
        document.getElementById('startMenu').classList.remove('active');
    }

    loadWallpaper() {
        // Try to load wallpaper from current profile
        fetch('/api/profiles/current/wallpaper')
            .then(res => res.ok ? res.blob() : null)
            .then(blob => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    document.getElementById('wallpaper').style.backgroundImage = `url(${url})`;
                }
            })
            .catch(() => {
                // Default gradient - already set in CSS
            });
    }

    loadCurrentUser() {
        fetch('/api/auth/current-user')
            .then(res => res.json())
            .then(data => {
                if (data.username) {
                    document.getElementById('currentUser').textContent = data.username;
                }
            })
            .catch(() => {});
    }

    openApp(appName) {
        if (this.dnsRefreshTimer) {
            clearInterval(this.dnsRefreshTimer);
            this.dnsRefreshTimer = null;
        }
        if (this.dnsAdlistUpdateTimer) {
            clearTimeout(this.dnsAdlistUpdateTimer);
            this.dnsAdlistUpdateTimer = null;
        }
        this.currentApp = appName;
        const windowEl = document.getElementById('window');
        const titleEl = document.getElementById('windowTitle');
        const contentEl = document.getElementById('windowContent');
        
        windowEl.style.zIndex = ++this.zIndex;
        windowEl.style.display = 'flex';
        windowEl.classList.remove('minimized', 'maximized');
        
        switch (appName) {
            case 'settings':
                titleEl.textContent = 'Settings';
                contentEl.innerHTML = `
                    <div class="app-page">
                        <header class="app-heading"><div><p class="eyebrow">PERSONALIZATION</p><h2>Profile settings</h2></div><span id="settingsProfile" class="status-chip">USB profile</span></header>
                        <form id="profileSettingsForm" class="settings-grid">
                            <label class="field">Theme<select id="profileTheme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
                            <label class="field">Accent<select id="profileAccent"><option value="blue">Harbor blue</option><option value="green">Signal green</option><option value="coral">Warm coral</option></select></label>
                            <label class="field field-wide">Sound volume <output id="volumeValue">80%</output><input id="profileVolume" type="range" min="0" max="100" value="80"></label>
                            <label class="check-field"><input id="notificationsEnabled" type="checkbox" checked> Notifications</label>
                            <label class="check-field"><input id="profileIsolation" type="checkbox"> Isolate this profile's storage</label>
                            <div class="field-wide button-row"><button class="action-button primary" type="submit">Save profile settings</button></div>
                        </form>
                        <section class="settings-section">
                            <h3>Wallpaper</h3><p>Stored with this profile on the USB drive. JPEG, PNG, or WebP up to 512 KiB.</p>
                            <div class="button-row"><input id="wallpaperFile" type="file" accept="image/jpeg,image/png,image/webp"><button class="action-button" id="uploadWallpaperBtn" type="button">Save wallpaper</button></div>
                        </section>
                        <section class="settings-section">
                            <h3>Administrator password</h3>
                            <form id="passwordForm" class="settings-grid">
                                <label class="field">Account<input id="adminUsername" value="Administrator" autocomplete="username"></label>
                                <label class="field">Current password<input id="currentPassword" type="password" autocomplete="current-password" required></label>
                                <label class="field">New password<input id="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
                                <div class="field-wide button-row"><button class="action-button primary" type="submit">Change password</button><span id="settingsMessage" role="status"></span></div>
                            </form>
                        </section>
                    </div>`;
                this.loadProfileSettings();
                document.getElementById('profileSettingsForm').addEventListener('submit', (event) => this.saveProfileSettings(event));
                document.getElementById('profileVolume').addEventListener('input', (event) => {
                    document.getElementById('volumeValue').textContent = `${event.target.value}%`;
                });
                document.getElementById('uploadWallpaperBtn').addEventListener('click', () => this.uploadWallpaper());
                document.getElementById('passwordForm').addEventListener('submit', (event) => this.changeAdminPassword(event));
                document.getElementById('profileIsolation').addEventListener('change', (event) => this.saveIsolation(event.target.checked));
                break;
            case 'dns-adblock':
                titleEl.textContent = 'DNS Ad-Blocker';
                contentEl.innerHTML = `
                    <div class="app-page dns-app" id="dnsApp">
                        <header class="app-heading"><div><p class="eyebrow">NETWORK SERVICE</p><h2>DNS filtering</h2></div><div class="dns-heading-actions"><label class="dns-theme-toggle"><input id="dnsThemeToggle" type="checkbox" role="switch"><span>Dark appearance</span></label><span id="dnsStatus" class="status-chip">Checking</span></div></header>
                        <div class="metric-grid dns-metrics">
                            <div class="metric"><span>Total queries</span><strong id="dnsTotal">0</strong></div>
                            <div class="metric"><span>Blocked queries</span><strong id="dnsBlocked">0</strong></div>
                            <div class="metric"><span>Block rate</span><strong id="dnsPct">0%</strong></div>
                            <div class="metric"><span>Rules in PSRAM</span><strong id="dnsCached">0</strong></div>
                        </div>
                        <section class="dns-dashboard">
                            <div class="dns-chart-card">
                                <div class="dns-section-heading"><div><h3>Query activity</h3><p>Daily view, grouped by hour (UTC)</p></div><button class="action-button" id="dnsRefreshBtn" type="button">Refresh</button></div>
                                <div class="dns-history-controls"><label for="dnsHistoryDate">Review date (UTC)</label><input id="dnsHistoryDate" type="date"></div>
                                <div class="dns-chart-scroll"><svg id="dnsHistoryChart" viewBox="0 0 600 210" role="img" aria-label="DNS query activity by hour for the selected date"></svg></div>
                                <div class="dns-chart-legend"><span class="allowed-key">Allowed</span><span class="blocked-key">Blocked</span><span class="failed-key">Failed</span></div>
                            </div>
                            <div class="dns-insights">
                                <div class="dns-chart-card">
                                    <h3>Query outcomes</h3>
                                    <div class="dns-pie-row"><div class="dns-pie" id="dnsOutcomePie" role="img" aria-label="Query outcome distribution"></div><ul class="dns-pie-legend"><li><span class="allowed-key"></span>Allowed <strong id="dnsAllowed">0</strong></li><li><span class="blocked-key"></span>Blocked <strong id="dnsBlockedTotal">0</strong></li><li><span class="failed-key"></span>Failed <strong id="dnsFailed">0</strong></li></ul></div>
                                </div>
                                <div class="dns-chart-card">
                                    <h3>Top queried domains</h3><p class="dns-muted">From the newest logged requests</p>
                                    <ol id="dnsTopQueries" class="dns-top-queries"><li>No logged requests yet.</li></ol>
                                </div>
                            </div>
                        </section>
                        <p id="dnsHistoryNote" class="dns-history-note">Daily history is saved to USB when the clock is synchronized.</p>
                        <form id="dnsConfigForm" class="settings-grid">
                            <label class="check-field field-wide"><input id="dnsEnabled" type="checkbox"> Enable DNS blocking</label>
                            <label class="check-field field-wide"><input id="dnsLogEnabled" type="checkbox"> Log queries for dashboard history</label>
                            <label class="field">Upstream resolver<input id="dnsUpstream" value="8.8.8.8" inputmode="decimal"></label>
                            <div class="field button-row"><button class="action-button primary" type="submit">Save DNS setup</button></div>
                        </form>
                        <section class="settings-section dns-adlists-section">
                            <div class="dns-adlists-heading"><div><h3>Adlists</h3><p>HTTPS hosts lists downloaded into the DNS rule cache.</p></div><button class="action-button" id="dnsAdlistUpdateBtn" type="button">Update enabled lists</button></div>
                            <form id="dnsAdlistForm" class="dns-adlist-form"><label class="field">List URL<input id="dnsAdlistUrl" type="url" placeholder="https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&amp;showintro=0&amp;mimetype=plaintext" required></label><label class="field">Category<select id="dnsAdlistType"><option value="0">Ads</option><option value="1">Tracking</option><option value="2">Malware</option><option value="3">Custom</option></select></label><button class="action-button" type="submit">Add list</button></form>
                            <p id="dnsAdlistMessage" class="form-message" role="status"></p>
                            <div id="dnsAdlistList" class="dns-adlist-list"><p>Loading adlists…</p></div>
                        </section>
                        <section class="settings-section">
                            <h3>Domain and regex rules</h3><p>Literal rules match a domain and its subdomains. Extended regular expressions use case-insensitive POSIX syntax; literal rules take precedence over regex rules.</p>
                            <form id="dnsRuleForm" class="rule-form"><input id="dnsDomain" placeholder="ads.example.com or ^ads[0-9]+\\.example\\.com$" required><select id="dnsRuleAction"><option value="block">Block</option><option value="allow">Allow</option></select><label class="check-field regex-toggle"><input id="dnsRegexRule" type="checkbox"> Regex</label><button class="action-button" type="submit">Add rule</button></form>
                            <p id="dnsMessage" class="form-message" role="status"></p>
                            <div class="dns-rule-list-wrap"><h4>Active rules</h4><div id="dnsRuleList" class="dns-rule-list"><p>Loading rules…</p></div></div>
                        </section>
                        <section class="settings-section">
                            <h3>Recent DNS requests</h3><div class="dns-table-scroll"><table class="dns-query-table"><thead><tr><th>UTC time</th><th>Domain</th><th>Client</th><th>Result</th></tr></thead><tbody id="dnsRecentQueries"><tr><td colspan="4">Loading requests…</td></tr></tbody></table></div>
                        </section>
                        <p class="service-note">Listening on UDP <span id="dnsPort">53</span> · upstream <span id="dnsUpstreamLabel">8.8.8.8</span></p>
                    </div>
                `;
                document.getElementById('dnsHistoryDate').value = new Date().toISOString().slice(0, 10);
                document.getElementById('dnsHistoryDate').addEventListener('change', () => this.loadDNSAnalytics());
                this.setDNSTheme(localStorage.getItem('dns-adblock-theme') === 'dark');
                document.getElementById('dnsThemeToggle').addEventListener('change', (event) => this.setDNSTheme(event.target.checked));
                this.loadDNSStats();
                this.loadDNSAnalytics();
                this.loadDNSAdlists();
                document.getElementById('dnsConfigForm').addEventListener('submit', (event) => this.saveDNSConfig(event));
                document.getElementById('dnsRuleForm').addEventListener('submit', (event) => this.addDNSRule(event));
                document.getElementById('dnsAdlistForm').addEventListener('submit', (event) => this.addDNSAdlist(event));
                document.getElementById('dnsAdlistUpdateBtn').addEventListener('click', () => this.updateDNSAdlists());
                document.getElementById('dnsRefreshBtn').addEventListener('click', () => {
                    this.loadDNSStats();
                    this.loadDNSAnalytics();
                });
                this.dnsRefreshTimer = setInterval(() => {
                    if (this.currentApp === 'dns-adblock') {
                        this.loadDNSStats();
                        this.loadDNSAnalytics();
                        this.loadDNSAdlists();
                    }
                }, 15000);
                break;
            case 'profiles':
                titleEl.textContent = 'User Profiles';
                contentEl.innerHTML = `
                    <div class="app-page">
                        <header class="app-heading"><div><p class="eyebrow">USB WORKSPACES</p><h2>Profiles</h2></div><span class="status-chip">Independent settings</span></header>
                        <div id="profileList" class="profile-list"><p>Loading profiles…</p></div>
                        <section class="settings-section">
                            <h3>Create a profile</h3>
                            <form id="createProfileForm" class="settings-grid">
                                <label class="field">Profile ID<input id="newProfileName" pattern="[A-Za-z0-9_-]+" maxlength="31" placeholder="studio" required></label>
                                <label class="field">Display name<input id="newProfileDisplay" maxlength="63" placeholder="Studio" required></label>
                                <div class="field-wide button-row"><button class="action-button primary" type="submit">Create profile</button><span id="profileMessage" role="status"></span></div>
                            </form>
                        </section>
                    </div>
                `;
                this.loadProfiles();
                document.getElementById('createProfileForm').addEventListener('submit', (event) => this.createProfile(event));
                break;
            case 'terminal':
                titleEl.textContent = 'Terminal';
                contentEl.innerHTML = `
                    <div style="padding:16px;background:#0c0c0c;height:100%;display:flex;flex-direction:column;">
                        <div id="terminalOutput" style="flex:1;font-family:Consolas,monospace;font-size:11px;color:#00ff00;overflow:auto;margin-bottom:8px;white-space:pre-wrap;"></div>
                        <input id="terminalInput" type="text" placeholder="Enter command..." style="padding:6px;font-family:Consolas,monospace;font-size:11px;background:#1e1e1e;color:#00ff00;border:1px solid #333;border-radius:4px;">
                    </div>
                `;
                const termInput = document.getElementById('terminalInput');
                termInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        this.executeTerminalCommand(termInput.value);
                        termInput.value = '';
                    }
                });
                termInput.focus();
                break;
            case 'file-explorer':
                titleEl.textContent = 'File Explorer';
                contentEl.innerHTML = `
                    <div style="padding:16px;">
                        <h2 style="margin-bottom:16px;font-size:16px;">USB File Explorer</h2>
                        <div style="background:#f8f9fa;padding:8px;border:1px solid #dee2e6;border-radius:4px;margin-bottom:8px;">
                            <span>/usb/</span>
                        </div>
                        <div id="fileList" style="border:1px solid #dee2e6;border-radius:4px;min-height:400px;padding:8px;"></div>
                    </div>
                `;
                this.loadFileExplorer();
                break;
        }
    }

    loadDNSStats() {
        fetch('/api/dns/stats')
            .then(res => {
                if (!res.ok) throw new Error('DNS statistics are unavailable.');
                return res.json();
            })
            .then(data => {
                document.getElementById('dnsTotal').textContent = data.total_queries || 0;
                document.getElementById('dnsBlocked').textContent = data.blocked_queries || 0;
                document.getElementById('dnsCached').textContent = data.cached_entries || 0;
                const total = data.total_queries || 0;
                const pct = total ? ((data.blocked_queries || 0) / total * 100).toFixed(1) : '0.0';
                document.getElementById('dnsPct').textContent = pct + '%';
                if (data.running) {
                    document.getElementById('dnsStatus').textContent = '● Running';
                    document.getElementById('dnsStatus').classList.add('is-running');
                    document.getElementById('dnsStatus').classList.remove('is-stopped');
                } else {
                    document.getElementById('dnsStatus').textContent = '● Stopped';
                    document.getElementById('dnsStatus').classList.add('is-stopped');
                    document.getElementById('dnsStatus').classList.remove('is-running');
                }
                document.getElementById('dnsEnabled').checked = Boolean(data.enabled);
                document.getElementById('dnsLogEnabled').checked = Boolean(data.log_queries);
                document.getElementById('dnsUpstream').value = data.upstream_dns || '8.8.8.8';
                document.getElementById('dnsUpstreamLabel').textContent = data.upstream_dns || '8.8.8.8';
                document.getElementById('dnsPort').textContent = data.port || 53;
            })
            .catch(error => {
                const status = document.getElementById('dnsStatus');
                if (status) status.textContent = error.message || 'DNS statistics unavailable';
            });
    }

    setDNSTheme(dark) {
        const app = document.getElementById('dnsApp');
        const toggle = document.getElementById('dnsThemeToggle');
        if (!app || !toggle) return;
        app.dataset.dnsTheme = dark ? 'dark' : 'light';
        toggle.checked = dark;
        localStorage.setItem('dns-adblock-theme', dark ? 'dark' : 'light');
    }

    async loadDNSAdlists() {
        const list = document.getElementById('dnsAdlistList');
        if (!list) return null;
        try {
            const response = await fetch('/api/dns/adlists', {cache: 'no-store'});
            if (!response.ok) throw new Error('Adlists are unavailable.');
            const data = await response.json();
            list.innerHTML = (data.lists || []).map(item => `
                <div class="dns-adlist-row">
                    <div class="dns-adlist-info"><strong>${this.escapeHTML(item.url)}</strong><span>${this.escapeHTML(item.type)} · ${Number(item.entry_count) || 0} entries · Updated ${this.escapeHTML(item.last_updated || 'Never')}</span></div>
                    <label class="dns-adlist-enabled"><input type="checkbox" data-adlist-enable="${Number(item.index)}" ${item.enabled ? 'checked' : ''} ${data.update_running ? 'disabled' : ''}><span>Enabled</span></label>
                    <button class="action-button" type="button" data-adlist-remove="${Number(item.index)}" ${data.update_running ? 'disabled' : ''}>Remove</button>
                </div>`).join('') || '<p>No adlists configured.</p>';
            list.querySelectorAll('[data-adlist-enable]').forEach(toggle => {
                toggle.addEventListener('change', () => this.setDNSAdlistEnabled(Number(toggle.dataset.adlistEnable), toggle.checked));
            });
            list.querySelectorAll('[data-adlist-remove]').forEach(button => {
                button.addEventListener('click', () => this.removeDNSAdlist(Number(button.dataset.adlistRemove)));
            });
            const updateButton = document.getElementById('dnsAdlistUpdateBtn');
            const message = document.getElementById('dnsAdlistMessage');
            updateButton.disabled = Boolean(data.update_running);
            message.textContent = data.update_status || 'Ready';
            if (data.update_running && this.currentApp === 'dns-adblock' && !this.dnsAdlistUpdateTimer) {
                this.dnsAdlistUpdateTimer = setTimeout(() => {
                    this.dnsAdlistUpdateTimer = null;
                    this.loadDNSAdlists();
                }, 2000);
            }
            return data;
        } catch (error) {
            list.innerHTML = `<p class="form-message">${this.escapeHTML(error.message || 'Could not load adlists.')}</p>`;
            return null;
        }
    }

    async addDNSAdlist(event) {
        event.preventDefault();
        const message = document.getElementById('dnsAdlistMessage');
        try {
            await this.postAdminJSON('/api/dns/adlists', {
                action: 'add',
                url: document.getElementById('dnsAdlistUrl').value.trim(),
                type: Number(document.getElementById('dnsAdlistType').value)
            });
            document.getElementById('dnsAdlistForm').reset();
            message.textContent = 'Adlist added.';
            await this.loadDNSAdlists();
        } catch (error) {
            message.textContent = error.message || 'Could not add the adlist.';
        }
    }

    async setDNSAdlistEnabled(index, enabled) {
        const message = document.getElementById('dnsAdlistMessage');
        try {
            await this.postAdminJSON('/api/dns/adlists', {action: enabled ? 'enable' : 'disable', index});
            message.textContent = enabled ? 'List enabled. Update lists to download it.' : 'List disabled.';
            await this.loadDNSAdlists();
            this.loadDNSStats();
            this.loadDNSRules();
        } catch (error) {
            message.textContent = error.message || 'Could not update the adlist.';
            await this.loadDNSAdlists();
        }
    }

    async removeDNSAdlist(index) {
        const message = document.getElementById('dnsAdlistMessage');
        try {
            await this.postAdminJSON('/api/dns/adlists', {action: 'remove', index});
            message.textContent = 'Adlist removed.';
            await this.loadDNSAdlists();
            this.loadDNSStats();
            this.loadDNSRules();
        } catch (error) {
            message.textContent = error.message || 'Could not remove the adlist.';
        }
    }

    async updateDNSAdlists() {
        const message = document.getElementById('dnsAdlistMessage');
        try {
            await this.postAdminJSON('/api/dns/adlists/update', {});
            message.textContent = 'Adlist update started.';
            await this.loadDNSAdlists();
        } catch (error) {
            message.textContent = error.message || 'Could not start the adlist update.';
        }
    }

    async loadDNSAnalytics() {
        if (!document.getElementById('dnsHistoryNote')) return;
        try {
            const selectedDate = document.getElementById('dnsHistoryDate').value;
            const dateQuery = `?date=${encodeURIComponent(selectedDate)}`;
            const [analyticsResponse, logResponse] = await Promise.all([
                fetch(`/api/dns/analytics${dateQuery}`, {cache: 'no-store'}),
                fetch(`/api/dns/log${dateQuery}`, {cache: 'no-store'})
            ]);
            if (!analyticsResponse.ok || !logResponse.ok) throw new Error('DNS history is unavailable.');
            const analytics = await analyticsResponse.json();
            const log = await logResponse.json();
            this.renderDNSAnalytics(analytics);
            this.renderDNSRecentQueries(log.entries || []);
            document.getElementById('dnsHistoryNote').textContent =
                `${analytics.history_source || 'Daily query history.'} · ${analytics.sample_size || 0} requests reviewed for ${selectedDate} UTC.`;
        } catch (error) {
            const note = document.getElementById('dnsHistoryNote');
            if (note) note.textContent = error.message || 'Could not load DNS history.';
        }
        this.loadDNSRules();
    }

    renderDNSAnalytics(analytics) {
        const timeline = Array.isArray(analytics.timeline) ? analytics.timeline : [];
        const chart = document.getElementById('dnsHistoryChart');
        if (!chart) return;
        const left = 42;
        const right = 584;
        const top = 18;
        const bottom = 162;
        const maximum = Math.max(1, ...timeline.map(point =>
            (Number(point.allowed) || 0) + (Number(point.blocked) || 0) + (Number(point.failed) || 0)));
        const series = [
            {key: 'allowed', color: '#34734f'},
            {key: 'blocked', color: '#bd5b3b'},
            {key: 'failed', color: '#8b7bb8'}
        ];
        const pointsFor = key => timeline.map((point, index) => {
            const x = timeline.length < 2 ? (left + right) / 2 :
                left + index * (right - left) / (timeline.length - 1);
            const y = bottom - (Number(point[key]) || 0) * (bottom - top) / maximum;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        const grid = [0, 1, 2, 3].map(index => {
            const y = top + index * (bottom - top) / 3;
            const value = Math.round(maximum * (3 - index) / 3);
            return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="dns-gridline"></line><text x="4" y="${y + 4}" class="dns-axis-label">${value}</text>`;
        }).join('');
        const labels = timeline.map((point, index) => {
            if (index % 3 !== 0 && index !== timeline.length - 1) return '';
            const x = timeline.length < 2 ? (left + right) / 2 :
                left + index * (right - left) / (timeline.length - 1);
            return `<text x="${x}" y="190" text-anchor="middle" class="dns-axis-label">${String(Number(point.hour) || 0).padStart(2, '0')}:00</text>`;
        }).join('');
        const lines = series.map(item =>
            `<polyline points="${pointsFor(item.key)}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>`
        ).join('');
        chart.innerHTML = `<g class="dns-chart-reveal">${grid}${labels}${lines}</g>`;

        const allowed = Number(analytics.allowed) || 0;
        const blocked = Number(analytics.blocked) || 0;
        const failed = Number(analytics.failed) || 0;
        document.getElementById('dnsAllowed').textContent = allowed;
        document.getElementById('dnsBlockedTotal').textContent = blocked;
        document.getElementById('dnsFailed').textContent = failed;
        const total = allowed + blocked + failed;
        const allowedStop = total ? allowed / total * 100 : 0;
        const blockedStop = total ? (allowed + blocked) / total * 100 : 0;
        document.getElementById('dnsOutcomePie').style.background = total
            ? `conic-gradient(#34734f 0% ${allowedStop}%, #bd5b3b ${allowedStop}% ${blockedStop}%, #8b7bb8 ${blockedStop}% 100%)`
            : 'conic-gradient(#d7e1df 0% 100%)';

        const topQueries = Array.isArray(analytics.top_queries) ? analytics.top_queries : [];
        const maxQueryCount = Math.max(1, ...topQueries.map(query => Number(query.count) || 0));
        document.getElementById('dnsTopQueries').innerHTML = topQueries.length
            ? topQueries.map(query => {
                const count = Number(query.count) || 0;
                const barWidth = Math.max(2, Math.min(100, count / maxQueryCount * 100));
                return `<li><div class="dns-query-rank"><span>${this.escapeHTML(query.domain)}</span><strong>${count}</strong></div><div class="dns-bar"><i style="width:${barWidth}%"></i></div></li>`;
            }).join('')
            : '<li>No logged requests yet.</li>';
    }

    renderDNSRecentQueries(entries) {
        const body = document.getElementById('dnsRecentQueries');
        if (!body) return;
        body.innerHTML = entries.length
            ? entries.slice(0, 12).map(entry => `
                <tr><td>${entry.timestamp_ms ? new Date(Number(entry.timestamp_ms)).toISOString().slice(11, 19) : '--:--:--'}</td><td>${this.escapeHTML(entry.domain)}</td><td>${this.escapeHTML(entry.client_ip)}</td>
                <td><span class="dns-result ${this.escapeHTML(entry.status)}">${this.escapeHTML(entry.status)}</span></td></tr>
            `).join('')
            : '<tr><td colspan="4">No logged requests yet.</td></tr>';
    }

    async loadDNSRules() {
        const list = document.getElementById('dnsRuleList');
        if (!list) return;
        try {
            const response = await fetch('/api/dns/domains?offset=0', {cache: 'no-store'});
            if (!response.ok) throw new Error('DNS rules are unavailable.');
            const data = await response.json();
            list.innerHTML = (data.rules || []).map(rule => `
                <div class="dns-rule-row">
                    <div><strong>${this.escapeHTML(rule.domain)}</strong><span>${rule.regex ? 'Regex' : 'Domain'} · ${rule.blocked ? 'Block' : 'Allow'} · ${Number(rule.hit_count) || 0} hits</span></div>
                    <button class="action-button" type="button" data-remove-rule="${this.escapeHTML(rule.domain)}" data-regex="${rule.regex ? 'true' : 'false'}">Remove</button>
                </div>`).join('') || '<p>No custom rules are configured.</p>';
            list.querySelectorAll('[data-remove-rule]').forEach(button => {
                button.addEventListener('click', () => this.removeDNSRule(button.dataset.removeRule, button.dataset.regex === 'true'));
            });
        } catch (error) {
            list.innerHTML = `<p class="form-message">${this.escapeHTML(error.message || 'Could not load DNS rules.')}</p>`;
        }
    }

    adminPassword() {
        return window.prompt('Administrator password');
    }

    async postAdminJSON(url, payload) {
        const password = this.adminPassword();
        if (!password) throw new Error('Administrator password was not provided');
        const response = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Admin-Password': password},
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
    }

    async saveDNSConfig(event) {
        event.preventDefault();
        const message = document.getElementById('dnsMessage');
        try {
            await this.postAdminJSON('/api/dns/config', {
                enabled: document.getElementById('dnsEnabled').checked,
                upstream_dns: document.getElementById('dnsUpstream').value.trim(),
                log_queries: document.getElementById('dnsLogEnabled').checked
            });
            message.textContent = 'DNS setup saved to USB.';
            this.loadDNSStats();
            this.loadDNSAnalytics();
        } catch (error) {
            message.textContent = error.message || 'Could not save DNS setup.';
        }
    }

    async addDNSRule(event) {
        event.preventDefault();
        const message = document.getElementById('dnsMessage');
        try {
            const domain = document.getElementById('dnsDomain').value.trim();
            const blocked = document.getElementById('dnsRuleAction').value === 'block';
            const regex = document.getElementById('dnsRegexRule').checked;
            await this.postAdminJSON('/api/dns/domains', {domain, blocked, regex});
            message.textContent = `${regex ? 'Regex' : 'Domain'} rule saved to USB.`;
            document.getElementById('dnsRuleForm').reset();
            this.loadDNSRules();
        } catch (error) {
            message.textContent = error.message || 'Could not save domain rule.';
        }
    }

    async removeDNSRule(domain, regex) {
        const message = document.getElementById('dnsMessage');
        try {
            await this.postAdminJSON('/api/dns/domains', {domain, regex, remove: true});
            message.textContent = 'DNS rule removed.';
            this.loadDNSRules();
        } catch (error) {
            message.textContent = error.message || 'Could not remove DNS rule.';
        }
    }

    async loadProfiles() {
        const list = document.getElementById('profileList');
        try {
            const [profilesResponse, currentResponse] = await Promise.all([
                fetch('/api/profiles/list'), fetch('/api/profiles/current')
            ]);
            if (!profilesResponse.ok || !currentResponse.ok) throw new Error('USB profile storage is unavailable.');
            const profiles = await profilesResponse.json();
            const current = await currentResponse.json();
            list.innerHTML = profiles.map((profile) => `
                <article class="profile-row ${profile.name === current.name ? 'is-current' : ''}">
                    <div><strong>${this.escapeHTML(profile.display_name || profile.name)}</strong><span>${this.escapeHTML(profile.name)}${profile.is_admin ? ' · Admin' : ''}${profile.name === current.name ? ' · Current' : ''}</span></div>
                    <button class="action-button" type="button" data-profile="${this.escapeHTML(profile.name)}" ${profile.name === current.name ? 'disabled' : ''}>Switch</button>
                </article>`).join('') || '<p>No profiles found on USB.</p>';
            list.querySelectorAll('[data-profile]').forEach((button) => {
                button.addEventListener('click', () => this.switchProfile(button.dataset.profile));
            });
        } catch (error) {
            list.innerHTML = `<p class="form-message">${this.escapeHTML(error.message || 'Unable to load profiles.')}</p>`;
        }
    }

    async switchProfile(name) {
        try {
            const response = await fetch('/api/profiles/switch', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name})
            });
            if (!response.ok) throw new Error(await response.text());
            this.loadProfiles();
            this.loadCurrentUser();
            this.loadWallpaper();
        } catch (error) {
            window.alert(error.message || 'Could not switch profile.');
        }
    }

    async createProfile(event) {
        event.preventDefault();
        const message = document.getElementById('profileMessage');
        try {
            await this.postAdminJSON('/api/profiles/create', {
                name: document.getElementById('newProfileName').value.trim(),
                display_name: document.getElementById('newProfileDisplay').value.trim(),
                is_admin: false
            });
            message.textContent = 'Profile saved to USB.';
            document.getElementById('createProfileForm').reset();
            this.loadProfiles();
        } catch (error) {
            message.textContent = error.message || 'Could not create profile.';
        }
    }

    async loadProfileSettings() {
        try {
            const [settingsResponse, profileResponse] = await Promise.all([
                fetch('/api/profiles/current/settings'), fetch('/api/profiles/current')
            ]);
            if (!settingsResponse.ok || !profileResponse.ok) throw new Error('USB profile settings unavailable.');
            const settings = await settingsResponse.json();
            const profile = await profileResponse.json();
            document.getElementById('settingsProfile').textContent = profile.display_name || profile.name;
            document.getElementById('profileTheme').value = settings.dark_mode ? 'dark' : 'light';
            document.getElementById('profileAccent').value = settings.theme === 'green' || settings.theme === 'coral' ? settings.theme : 'blue';
            document.documentElement.dataset.mode = settings.dark_mode ? 'dark' : 'light';
            document.documentElement.dataset.accent = document.getElementById('profileAccent').value;
            document.getElementById('profileVolume').value = settings.sound_volume ?? 80;
            document.getElementById('volumeValue').textContent = `${document.getElementById('profileVolume').value}%`;
            document.getElementById('notificationsEnabled').checked = settings.notifications_enabled !== false;
            document.getElementById('profileIsolation').checked = Boolean(profile.storage_isolated);
        } catch (error) {
            document.getElementById('settingsMessage').textContent = error.message || 'Could not load profile settings.';
        }
    }

    async saveProfileSettings(event) {
        event.preventDefault();
        const message = document.getElementById('settingsMessage');
        const response = await fetch('/api/profiles/current/settings', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                theme: document.getElementById('profileAccent').value,
                dark_mode: document.getElementById('profileTheme').value === 'dark',
                sound_volume: Number(document.getElementById('profileVolume').value),
                notifications_enabled: document.getElementById('notificationsEnabled').checked
            })
        });
        document.documentElement.dataset.mode = document.getElementById('profileTheme').value;
        document.documentElement.dataset.accent = document.getElementById('profileAccent').value;
        message.textContent = response.ok ? 'Settings saved to USB.' : 'Could not save profile settings.';
    }

    async uploadWallpaper() {
        const file = document.getElementById('wallpaperFile').files[0];
        const message = document.getElementById('settingsMessage');
        if (!file) { message.textContent = 'Choose an image first.'; return; }
        const password = this.adminPassword();
        if (!password) return;
        try {
            const response = await fetch('/api/profiles/current/wallpaper', {
                method: 'POST', headers: {'Content-Type': file.type, 'X-Admin-Password': password}, body: file
            });
            if (!response.ok) throw new Error(await response.text());
            message.textContent = 'Wallpaper saved to this profile on USB.';
            this.loadWallpaper();
        } catch (error) {
            message.textContent = error.message || 'Could not save wallpaper.';
        }
    }

    async saveIsolation(enabled) {
        try {
            await this.postAdminJSON('/api/profiles/current/isolation', {enabled});
            document.getElementById('settingsMessage').textContent = 'Profile isolation saved to USB.';
        } catch (error) {
            document.getElementById('profileIsolation').checked = !enabled;
            document.getElementById('settingsMessage').textContent = error.message || 'Could not save isolation setting.';
        }
    }

    async changeAdminPassword(event) {
        event.preventDefault();
        const message = document.getElementById('settingsMessage');
        const payload = {
            username: document.getElementById('adminUsername').value.trim(),
            current_password: document.getElementById('currentPassword').value,
            new_password: document.getElementById('newPassword').value
        };
        try {
            const response = await fetch('/api/auth/password', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(await response.text());
            document.getElementById('passwordForm').reset();
            document.getElementById('adminUsername').value = payload.username;
            message.textContent = 'Administrator password saved to USB.';
        } catch (error) {
            message.textContent = error.message || 'Could not update administrator password.';
        }
    }

    escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    loadFileExplorer() {
        fetch('/api/storage/list?path=/')
            .then(res => res.json())
            .then(data => {
                const listEl = document.getElementById('fileList');
                if (data.entries) {
                    let html = '<div style="display:flex;flex-direction:column;gap:4px;">';
                    data.entries.forEach(entry => {
                        html += `<div style="padding:4px;cursor:pointer;display:flex;gap:8px;align-items:center;">
                            <span>${entry.isFolder ? '📁' : '📄'}</span>
                            <span>${entry.name}</span>
                        </div>`;
                    });
                    html += '</div>';
                    listEl.innerHTML = html;
                }
            })
            .catch(() => {});
    }

    executeTerminalCommand(cmd) {
        const outputEl = document.getElementById('terminalOutput');
        outputEl.textContent += '> ' + cmd + '\n';
        fetch('/api/terminal/exec', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({command: cmd})
        })
            .then(res => res.json())
            .then(data => {
                if (data.output) {
                    outputEl.textContent += data.output + '\n';
                }
            })
            .catch(() => {
                outputEl.textContent += 'Command failed\n';
            });
        outputEl.scrollTop = outputEl.scrollHeight;
    }

    shutdown() {
        if (confirm('Shutdown preparation will flush data and stop network services. You must cut power using external hardware. Continue?')) {
            this.requestPowerAction('/api/system/shutdown', 'shutdown preparation');
        }
    }

    async requestPowerAction(endpoint, action) {
        const password = prompt(`Administrator password required for ${action}:`);
        if (password === null) return;
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({password})
            });
            if (!response.ok) {
                const message = await response.text();
                throw new Error(message || `Request failed (HTTP ${response.status})`);
            }
            if (endpoint === '/api/system/shutdown') {
                alert('Shutdown preparation started. Wait for the purple WS2812 LED, then cut power using external hardware.');
            } else {
                alert('Restart requested. The ESP32 will restart after USB storage is prepared.');
            }
        } catch (error) {
            console.error(`System ${action} request failed`, error);
            alert(error instanceof Error ? error.message : `System ${action} request failed.`);
        }
    }

    minimizeWindow() {
        document.getElementById('window').classList.add('minimized');
    }

    maximizeWindow() {
        document.getElementById('window').classList.toggle('maximized');
    }

    closeWindow() {
        document.getElementById('window').style.display = 'none';
        this.currentApp = null;
        if (this.dnsRefreshTimer) {
            clearInterval(this.dnsRefreshTimer);
            this.dnsRefreshTimer = null;
        }
    }

    dragWindow(e) {
        const windowEl = document.getElementById('window');
        const rect = windowEl.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        
        function onMouseMove(e) {
            if (windowEl.classList.contains('maximized')) return;
            windowEl.style.left = e.clientX - startX + 'px';
            windowEl.style.top = e.clientY - startY + 'px';
        }
        
        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new Win11OS();
});