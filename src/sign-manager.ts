import { requestUrl } from 'obsidian';
import { signRequest, USER_AGENT, SignHeaders } from './signing';
import { log, logError } from './logger';

const XHS_EXPLORE = 'https://www.xiaohongshu.com/explore';
const WEBVIEW_PARTITION = 'persist:redbook-pull';
const LOAD_TIMEOUT_MS = 30000;

// Injected into the WebView to capture x-rap-param from XHS's own API calls.
// Patches Headers.prototype (deepest level) so we intercept even when XHS
// adds the header inside its own patched fetch wrapper.
const RAP_INTERCEPTOR = `(function() {
  if (window.__rapIntercepted) return;
  window.__rapIntercepted = true;
  window.__capturedRapParam = window.__capturedRapParam || '';
  function capture(name, value) {
    try { if (name && name.toLowerCase() === 'x-rap-param' && value) window.__capturedRapParam = value; } catch(_) {}
  }
  var _hset = Headers.prototype.set;
  Headers.prototype.set = function(n, v) { capture(n, v); return _hset.apply(this, arguments); };
  var _happend = Headers.prototype.append;
  Headers.prototype.append = function(n, v) { capture(n, v); return _happend.apply(this, arguments); };
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var h = (init && init.headers) || {};
      capture('x-rap-param', h instanceof Headers ? h.get('x-rap-param') : (h['x-rap-param'] || h['X-Rap-Param']));
    } catch(_) {}
    return _fetch.apply(this, arguments);
  };
  var _xhr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(n, v) { capture(n, v); return _xhr.apply(this, arguments); };
})(); true;`;

// After interceptor is live, trigger a lightweight XHS API call so XHS's own
// fetch wrapper adds x-rap-param — our Headers.prototype.set patch captures it.
const WARMUP_FETCH = `(async function() {
  try {
    await fetch('https://edith.xiaohongshu.com/api/sns/web/v1/homefeed', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cursor_score: '', num: 1, refresh_type: 1, note_index: 0,
        unread_begin_note_id: '', unread_end_note_id: '', unread_note_count: 0,
        category: 'homefeed_recommend', search_key: ''
      })
    });
  } catch(_) {}
})(); true;`;

export class SignManager {
  private container: HTMLDivElement | null = null;
  private webview: Electron.WebviewTag | null = null;
  private webviewReady = false;

  async init(): Promise<void> {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(this.container);

    this.webview = document.createElement('webview') as Electron.WebviewTag;
    this.webview.setAttribute('src', XHS_EXPLORE);
    this.webview.setAttribute('partition', WEBVIEW_PARTITION);
    this.webview.setAttribute('useragent', USER_AGENT);
    this.webview.style.cssText = 'width:1px;height:1px;';
    this.container.appendChild(this.webview);

    // Re-inject interceptor on any subsequent page load
    this.webview.addEventListener('did-finish-load', () => {
      if (this.webviewReady) this.injectInterceptor();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebView 加载超时')), LOAD_TIMEOUT_MS);
      this.webview!.addEventListener('did-finish-load', () => {
        clearTimeout(timer);
        this.webviewReady = true;
        this.injectInterceptor();
        resolve();
      }, { once: true });
      this.webview!.addEventListener('did-fail-load', () => {
        clearTimeout(timer);
        reject(new Error('WebView 加载失败'));
      }, { once: true });
    });

    log('[RedbookPull] SignManager ready');
  }

  private injectInterceptor(): void {
    const wv = this.webview as any;
    if (!wv) return;
    wv.executeJavaScript(RAP_INTERCEPTOR)
      .then(() => wv.executeJavaScript(WARMUP_FETCH))
      .catch((e: any) => logError('[RedbookPull] interceptor inject failed', e));
  }

  private async readRapParam(timeoutMs = 10000): Promise<string> {
    if (!this.webviewReady || !this.webview) return '';
    const INTERVAL = 400;
    let elapsed = 0;
    while (elapsed < timeoutMs) {
      try {
        const val: string = await (this.webview as any).executeJavaScript('window.__capturedRapParam || ""');
        if (val) { log(`[RedbookPull] x-rap-param ready after ${elapsed}ms`); return val; }
      } catch { return ''; }
      await new Promise(r => setTimeout(r, INTERVAL));
      elapsed += INTERVAL;
    }
    log('[RedbookPull] x-rap-param not captured within timeout, proceeding without');
    return '';
  }

  isReady(): boolean {
    return true;
  }

  async request(
    signPath: string,
    fetchUrl: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>,
    cookies = '',
  ): Promise<unknown> {
    if (!cookies) throw new Error('未登录，请先登录小红书');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cookie': cookies,
      'Origin': 'https://www.xiaohongshu.com',
      'Referer': 'https://www.xiaohongshu.com/',
      'User-Agent': USER_AGENT,
    };

    let signHeaders: SignHeaders;
    try {
      signHeaders = signRequest(signPath, method, cookies, body);
    } catch (e: any) {
      throw new Error(`签名失败: ${e.message}`);
    }
    Object.assign(headers, signHeaders);

    const rapParam = await this.readRapParam();
    if (rapParam) {
      headers['x-rap-param'] = rapParam;
      log(`[RedbookPull] x-rap-param attached (${rapParam.length} chars)`);
    } else {
      log('[RedbookPull] x-rap-param not captured yet');
    }

    const h = signHeaders;
    const headerFlags = [
      `-H 'x-s: ${h['x-s']}'`,
      `-H 'x-t: ${h['x-t']}'`,
      `-H 'x-s-common: ${h['x-s-common']}'`,
      `-H 'x-b3-traceid: ${h['x-b3-traceid']}'`,
      `-H 'x-xray-traceid: ${h['x-xray-traceid']}'`,
      ...(rapParam ? [`-H 'x-rap-param: ${rapParam}'`] : []),
      `-H 'Content-Type: application/json;charset=UTF-8'`,
      `-H 'Origin: https://www.xiaohongshu.com'`,
      `-H 'Referer: https://www.xiaohongshu.com/'`,
      `-H 'Cookie: ${cookies}'`,
    ].join(' \\\n  ');
    const bodyFlag = body ? ` \\\n  -d '${JSON.stringify(body)}'` : '';
    log(`[CURL] curl -X ${method} '${fetchUrl}' \\\n  ${headerFlags}${bodyFlag}`);

    const resp = await requestUrl({
      url: fetchUrl,
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });

    log(`[RedbookPull] request status=${resp.status} body=${JSON.stringify(resp.json).slice(0, 500)}`);

    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);

    const respBody = resp.json as any;
    if (respBody?.success === false) {
      throw new Error(`XHS错误 code=${respBody.code} msg=${respBody.msg ?? respBody.message ?? ''}`);
    }

    return respBody?.data !== undefined ? respBody.data : respBody;
  }

  async fetchBinary(url: string): Promise<ArrayBuffer> {
    if (!this.webviewReady || !this.webview) {
      throw new Error('WebView 未就绪，请等待几秒后重试');
    }
    const safeUrl = url.replace(/^http:\/\//i, 'https://');
    const script = `(async function() {
  try {
    const resp = await fetch(${JSON.stringify(safeUrl)}, {
      method: 'GET',
      headers: { 'Referer': 'https://www.xiaohongshu.com/' }
    });
    if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status });
    const arr = new Uint8Array(await resp.arrayBuffer());
    let binary = '';
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  } catch(e) { return JSON.stringify({ error: e.message }); }
})()`;
    const result: any = await (this.webview as any).executeJavaScript(script);
    if (typeof result === 'string' && result.startsWith('{')) {
      const parsed = JSON.parse(result);
      if (parsed?.error) throw new Error(`图片下载失败: ${parsed.error}`);
    }
    const binary = atob(result as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  destroy(): void {
    this.webviewReady = false;
    this.webview = null;
    this.container?.remove();
    this.container = null;
  }
}
