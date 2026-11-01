import { useState, useEffect, useRef } from "react";
import { dump } from "src/lib/utils/helpers";
import { setIcon } from "obsidian";
import FastSync from "src/main";

import { UserDTO } from "../lib/api/http_api_service";
import { $ } from "../i18n/lang";


async function getClipboardContent(plugin: FastSync): Promise<void> {
  const clipboardReadTipSave = async (api: string, apiToken: string, Vault: string, tip: string) => {
    if (plugin.settings.api != api || plugin.settings.apiToken != apiToken) {
      plugin.wsSettingChange = true
    }
    plugin.settings.api = api
    plugin.settings.apiToken = apiToken
    plugin.settings.vault = Vault
    plugin.clipboardReadTip = tip

    plugin.localStorageManager.clearSyncTime()
    await plugin.saveAndReloadServices()
    plugin.settingTab.refresh()

    window.setTimeout(() => {
      plugin.clipboardReadTip = ""
      plugin.settingTab.refresh()
    }, 2000)
  }

  //
  const clipboardReadTipTipSave = async (tip: string) => {
    plugin.clipboardReadTip = tip

    await plugin.saveAndReloadServices()
    plugin.settingTab.refresh()

    window.setTimeout(() => {
      plugin.clipboardReadTip = ""
      plugin.settingTab.refresh()
    }, 2000)
  }

  try {
    // 检查浏览器是否支持 Clipboard API
    if (!navigator.clipboard) {
      return
    }

    // 获取剪贴板文本内容
    const text = await navigator.clipboard.readText()

    // 检查是否为 JSON 格式
    const parsedData = JSON.parse(text) as Record<string, unknown>;
    // 检查是否为对象且包含 api 和 apiToken
    if (typeof parsedData === "object" && parsedData !== null) {
      const hasApi = "api" in parsedData
      const hasApiToken = "apiToken" in parsedData
      const vault = "vault" in parsedData

      if (hasApi && hasApiToken && vault) {
        void clipboardReadTipSave(parsedData.api as string, parsedData.apiToken as string, parsedData.vault as string, $("setting.remote.paste_success"))
        return
      }
    }
    void clipboardReadTipTipSave($("setting.remote.no_config"))
    return
  } catch (err) {
    dump(err)
    void clipboardReadTipTipSave($("setting.remote.no_config"))
    return
  }
}

const handleClipboardClick = (plugin: FastSync) => {
  getClipboardContent(plugin).catch(err => { dump(err); });
};

export const SettingsView = ({ plugin }: { plugin: FastSync }) => {
  const [isConnected, setIsConnected] = useState<boolean>(plugin.websocket.isConnected());
  const [userInfo, setUserInfo] = useState<UserDTO | null>(null);
  const [loadingUserInfo, setLoadingUserInfo] = useState<boolean>(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const listener = (status: boolean) => {
      if (isMounted.current) {
        setIsConnected(status);
      }
    };

    plugin.websocket.addStatusListener(listener);
    return () => {
      plugin.websocket.removeStatusListener(listener);
    };
  }, [plugin.websocket]);

  useEffect(() => {
    if (isConnected && !userInfo && !loadingUserInfo) {
      setLoadingUserInfo(true);
      plugin.api.getUserInfo()
        .then(data => {
          if (!isMounted.current) return;
          setUserInfo(data);
          setLoadingUserInfo(false);
        })
        .catch(err => {
          dump("Failed to fetch user info:", err);
          if (!isMounted.current) return;
          setLoadingUserInfo(false);
        });
    } else if (!isConnected && (userInfo || loadingUserInfo)) {
      setUserInfo(null);
      setLoadingUserInfo(false);
    }
  }, [isConnected, plugin.api, userInfo, loadingUserInfo]);

  useEffect(() => {
    if (iconRef.current) {
      iconRef.current.empty();
      setIcon(iconRef.current, isConnected ? "wifi" : "wifi-off");
    }
  }, [isConnected]);

  // 现代化的 Markdown 表格渲染，移动端自动转为卡片列表
  const renderMarkdownTable = (content: string) => {
    const lines = content.split('\n');
    const tableData = lines.filter(line => line.trim().startsWith('|') && line.trim().endsWith('|'));
    if (tableData.length < 2) return null;

    const parseRow = (row: string) => row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(s => s.trim());
    parseRow(tableData[0]);
    const bodyRows = tableData.slice(2).map(parseRow);

    // 解析链接并在新窗口打开
    const handleMethodClick = (htmlContent: string) => {
      const match = htmlContent.match(/href=['"]([^'"]+)['"]/);
      if (match && match[1]) {
        window.open(match[1], '_blank');
      }
    };

    return (
      <div className="fns-setup-methods">
        {bodyRows.map((row, i) => (
          <div key={i} className="fns-method-card" onClick={() => handleMethodClick(row[1])}>
            <div className="fns-method-icon">
              <span dangerouslySetInnerHTML={{ __html: i === 0 ? "🛠️" : "☁️" }} />
            </div>
            <div className="fns-method-info">
              <div className="fns-method-title">{row[0]}</div>
              <div className="fns-method-desc" dangerouslySetInnerHTML={{ __html: row[1] }} />
            </div>
            <div className="fns-method-arrow">→</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="fns-remote-config-container">
      <div className="fns-setup-group-card">
        <div className="fns-setup-content">
          {renderMarkdownTable($("setting.remote.setup_table"))}

          <div className="fns-action-group">
            <button className="fns-premium-btn" onClick={() => handleClipboardClick(plugin)}>
              <span className="fns-btn-icon">📋</span>
              {$("setting.remote.paste_config")}
            </button>

            <div className={`fns-status-pill ${isConnected ? 'is-connected' : 'is-disconnected'}`}>
              <div className="fns-status-dot" />
              <span className="fns-status-label">
                {isConnected ? $("setting.remote.connected") : $("setting.remote.disconnected")}
              </span>
              {isConnected && userInfo && (
                <div className="fns-status-account">
                  <span className="fns-sep">/</span>
                  <span className="fns-account-name">{userInfo.username}</span>
                  <span className="fns-uid-badge">ID:{userInfo.uid}</span>
                </div>
              )}
            </div>

            {plugin.clipboardReadTip && (
              <div className="fns-paste-toast">{plugin.clipboardReadTip}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
