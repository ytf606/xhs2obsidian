import { App, Modal, Notice, requestUrl } from 'obsidian';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RedbookPullSettings } from './types';
import { XhsApi } from './xhs-api';

const XHS_LOGIN_URL = 'https://www.xiaohongshu.com/explore';
const LOGIN_PARTITION = 'persist:redbook-pull';

// Fixed Chrome version reported to XHS — must stay consistent across Obsidian updates
// to prevent device fingerprint changes from triggering "new device" verification.
const PINNED_CHROME_VER = '120';
const PINNED_CHROME_FULL = '120.0.6099.129';

// Injected before any page script runs to freeze navigator.userAgentData
const WEBVIEW_PRELOAD = `
;(function () {
  var VER = '${PINNED_CHROME_VER}';
  var FULL = '${PINNED_CHROME_FULL}';
  var brands = [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: VER },
    { brand: 'Google Chrome', version: VER },
  ];
  var fullVersionList = [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: FULL },
    { brand: 'Google Chrome', version: FULL },
  ];
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: function () {
        return {
          brands: brands,
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: function () {
            return Promise.resolve({
              architecture: 'arm',
              bitness: '64',
              brands: brands,
              fullVersionList: fullVersionList,
              mobile: false,
              platform: 'macOS',
              platformVersion: '14.0.0',
              uaFullVersion: FULL,
            });
          },
        };
      },
      configurable: true,
    });
  } catch (_) {}
})();
`;

export class LoginModal extends Modal {
  private webview: Electron.WebviewTag | null = null;
  private statusEl: HTMLElement | null = null;
  private settings: RedbookPullSettings;
  private onSuccess: () => void;

  constructor(app: App, settings: RedbookPullSettings, onSuccess: () => void) {
    super(app);
    this.settings = settings;
    this.onSuccess = onSuccess;
  }

  onOpen(): void {
    this.modalEl.addClass('redbook-pull-login-modal');
    const { contentEl } = this;
    contentEl.empty();

    // WebView 容器
    const wvContainer = contentEl.createDiv({ cls: 'redbook-pull-webview-container' });
    this.webview = document.createElement('webview') as Electron.WebviewTag;
    this.webview.setAttribute('src', XHS_LOGIN_URL);
    this.webview.setAttribute('partition', LOGIN_PARTITION);
    this.webview.setAttribute('useragent',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${PINNED_CHROME_VER}.0.0.0 Safari/537.36`);

    // Write preload script to a fixed temp path so navigator.userAgentData is overridden
    // before any XHS page script runs, preventing "new device" fingerprint changes.
    try {
      const preloadPath = path.join(os.tmpdir(), 'xhs2obsidian-webview-preload.js');
      fs.writeFileSync(preloadPath, WEBVIEW_PRELOAD, 'utf8');
      this.webview.setAttribute('preload', `file://${preloadPath}`);
    } catch (_) {}

    wvContainer.appendChild(this.webview);

    // 底部操作栏
    const actions = contentEl.createDiv({ cls: 'redbook-pull-login-actions' });
    this.statusEl = actions.createSpan({ cls: 'redbook-pull-login-status', text: '请在上方网页登录小红书账号' });

    const btn = actions.createEl('button', { text: '登录完成，提取 Cookie', cls: 'mod-cta' });
    btn.addEventListener('click', () => this.handleLoginComplete());
  }

  private async handleLoginComplete(): Promise<void> {
    if (!this.webview) return;

    this.setStatus('正在提取登录信息…');

    try {
      let cookieStr = '';
      let a1Cookie = '';
      let webSession = '';

      // 优先用 Electron session API（可读 HttpOnly cookie）
      try {
        const electron = (window as any).require('electron');
        const { session } = electron.remote ?? electron;
        const ses = session.fromPartition(LOGIN_PARTITION);
        const cookies: Array<{ name: string; value: string }> =
          await ses.cookies.get({ url: 'https://www.xiaohongshu.com' });
        cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        a1Cookie = cookies.find(c => c.name === 'a1')?.value ?? '';
        webSession = cookies.find(c => c.name === 'web_session')?.value ?? '';
      } catch {
        // 降级：document.cookie（缺 HttpOnly 部分，仍可判断登录态）
        cookieStr = await (this.webview as any).executeJavaScript('document.cookie');
        const m = cookieStr.match(/a1=([^;]+)/);
        a1Cookie = m ? m[1] : '';
        const ws = cookieStr.match(/web_session=([^;]+)/);
        webSession = ws ? ws[1] : '';
      }

      if (!cookieStr) {
        this.setStatus('❌ 未检测到 Cookie，请确保已登录');
        return;
      }
      if (!webSession) {
        this.setStatus('❌ 未检测到登录会话，请先在上方页面完成小红书账号登录');
        return;
      }
      if (!a1Cookie) {
        this.setStatus('❌ 未检测到 a1 Cookie，请确保已完成登录');
        return;
      }

      // Verify the session is actually valid (guards against stale persisted cookies)
      this.setStatus('正在验证登录状态…');
      const verifyResp = await requestUrl({
        url: 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://www.xiaohongshu.com',
          'Referer': 'https://www.xiaohongshu.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Cookie: cookieStr,
        },
        throw: false,
      });
      const userInfo = verifyResp.json?.data;
      if (!userInfo?.user_id) {
        this.setStatus('❌ 登录验证失败，请先完成小红书扫码登录后再点击此按钮');
        return;
      }

      this.settings.cookies = cookieStr;
      this.settings.a1Cookie = a1Cookie;

      this.setStatus(`✅ 登录成功：${userInfo.nickname ?? userInfo.user_id}`);
      new Notice('Redbook Pull：登录成功');
      setTimeout(() => {
        this.onSuccess();
        this.close();
      }, 400);
    } catch (e: any) {
      this.setStatus(`❌ 出错：${e.message}`);
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  onClose(): void {
    this.contentEl.empty();
    this.webview = null;
    this.statusEl = null;
  }
}
