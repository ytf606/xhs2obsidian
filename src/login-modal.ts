import { App, Modal, Notice } from 'obsidian';
import { RedbookPullSettings } from './types';
import { XhsApi } from './xhs-api';

const XHS_LOGIN_URL = 'https://www.xiaohongshu.com/explore';
const LOGIN_PARTITION = 'persist:redbook-pull';

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
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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

      // 优先用 Electron session API（可读 HttpOnly cookie）
      try {
        const electron = (window as any).require('electron');
        const { session } = electron.remote ?? electron;
        const ses = session.fromPartition(LOGIN_PARTITION);
        const cookies: Array<{ name: string; value: string }> =
          await ses.cookies.get({ url: 'https://www.xiaohongshu.com' });
        cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        a1Cookie = cookies.find(c => c.name === 'a1')?.value ?? '';
      } catch {
        // 降级：document.cookie（缺 HttpOnly 部分，仍可判断 a1）
        cookieStr = await (this.webview as any).executeJavaScript('document.cookie');
        const m = cookieStr.match(/a1=([^;]+)/);
        a1Cookie = m ? m[1] : '';
      }

      if (!cookieStr) {
        this.setStatus('❌ 未检测到 Cookie，请确保已登录');
        return;
      }
      if (!a1Cookie) {
        this.setStatus('❌ 未检测到 a1 Cookie，请确保已完成登录');
        return;
      }

      this.settings.cookies = cookieStr;
      this.settings.a1Cookie = a1Cookie;

      this.setStatus('✅ Cookie 已保存，正在初始化…');
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
