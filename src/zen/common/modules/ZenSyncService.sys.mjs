/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
});

function bufToBase64(buf) {
  const arr = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < arr.byteLength; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class nsZenSyncService {
  #initialized = false;
  #syncIntervalId = null;

  init() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Start periodic sync every 5 minutes if configured
    this.startPeriodicSync();
  }

  async isConfigured() {
    const accountId = Services.prefs.getStringPref("zen.sync.account_id", "");
    const deviceId = Services.prefs.getStringPref("zen.sync.device_id", "");
    return !!(accountId && deviceId);
  }

  async getConfig() {
    return {
      relayUrl: Services.prefs.getStringPref("zen.sync.relay_url", ""),
      accountId: Services.prefs.getStringPref("zen.sync.account_id", ""),
      deviceId: Services.prefs.getStringPref("zen.sync.device_id", ""),
      deviceName: Services.prefs.getStringPref("zen.sync.device_name", ""),
      salt: Services.prefs.getStringPref("zen.sync.salt", ""),
    };
  }

  async getStatus() {
    const lastSyncTime = Services.prefs.getStringPref("zen.sync.last_sync_time", "");
    const lastSyncDetails = Services.prefs.getStringPref("zen.sync.last_sync_details", "");
    const connected = Services.prefs.getBoolPref("zen.sync.connected", false);
    return {
      lastSyncTime: lastSyncTime ? parseInt(lastSyncTime, 10) : null,
      lastSyncDetails,
      connected,
    };
  }

  async storeSecret(username, secret) {
    // Remove existing if any
    this.deleteSecret(username);

    const loginInfo = Cc["@mozilla.org/loginmanager/logininfo;1"].createInstance(Ci.nsILoginInfo);
    loginInfo.init("chrome://zensync", null, "Zen Sync Credential Manager", username, secret, "", "");
    Services.logins.addLogin(loginInfo);
  }

  getSecret(username) {
    const logins = Services.logins.findLogins("chrome://zensync", null, "Zen Sync Credential Manager");
    const login = logins.find(l => l.username === username);
    return login ? login.password : null;
  }

  deleteSecret(username) {
    const logins = Services.logins.findLogins("chrome://zensync", null, "Zen Sync Credential Manager");
    const login = logins.find(l => l.username === username);
    if (login) {
      Services.logins.removeLogin(login);
    }
  }

  async deriveKeys(passphrase, saltB64) {
    const salt = base64ToBuf(saltB64);
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey", "deriveBits"]
    );

    const encryptionKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const authBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode(saltB64 + "_auth_salt"),
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      256
    );

    const authToken = Array.from(new Uint8Array(authBits))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return { encryptionKey, authToken };
  }

  async encryptState(encryptionKey, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      encryptionKey,
      enc.encode(JSON.stringify(data))
    );
    return {
      ciphertext: bufToBase64(ciphertext),
      nonce: bufToBase64(iv)
    };
  }

  async decryptState(encryptionKey, ciphertextB64, nonceB64) {
    const ciphertext = base64ToBuf(ciphertextB64);
    const iv = base64ToBuf(nonceB64);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      encryptionKey,
      ciphertext
    );
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  }

  async relayRequest(path, method = "GET", body = null, overrideHeaders = {}) {
    const relayUrl = Services.prefs.getStringPref("zen.sync.relay_url", "");
    if (!relayUrl) throw new Error("Relay URL not configured");

    const accountId = Services.prefs.getStringPref("zen.sync.account_id", "");
    const authToken = this.getSecret("auth_token");

    const headers = {
      "Content-Type": "application/json",
      ...overrideHeaders
    };
    if (accountId) headers["X-Account-Id"] = accountId;
    if (authToken) headers["X-Auth-Token"] = authToken;

    const req = { method, headers };
    if (body) req.body = JSON.stringify(body);

    const res = await fetch(`${relayUrl}${path}`, req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay error: ${res.status} ${text.substring(0, 100)}`);
    }
    return res.json();
  }

  async setupAccount({ relayUrl, token, passphrase, deviceName }) {
    // Generate salt (16 bytes)
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bufToBase64(saltBytes);

    const { encryptionKey, authToken } = await this.deriveKeys(passphrase, saltB64);

    // Compute hash for auth token (sha256 of auth token + salt)
    const authHashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(authToken + "_server_salt")
    );
    const authHash = Array.from(new Uint8Array(authHashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // 1. Register account
    const regHeader = {};
    if (token) regHeader["X-Registration-Token"] = token;
    
    // Temporarily save relay URL to allow relayRequest to resolve
    Services.prefs.setStringPref("zen.sync.relay_url", relayUrl);

    const regResp = await this.relayRequest("/api/register", "POST", { auth_hash: authHash }, regHeader);

    // 2. Register device
    const deviceResp = await this.relayRequest(
      "/api/devices",
      "POST",
      { name: deviceName },
      { "X-Account-Id": regResp.account_id, "X-Auth-Token": authToken }
    );

    // 3. Save config
    Services.prefs.setStringPref("zen.sync.account_id", regResp.account_id);
    Services.prefs.setStringPref("zen.sync.device_id", deviceResp.device_id);
    Services.prefs.setStringPref("zen.sync.device_name", deviceName);
    Services.prefs.setStringPref("zen.sync.salt", saltB64);
    Services.prefs.setBoolPref("zen.sync.connected", true);

    await this.storeSecret("auth_token", authToken);
    await this.storeSecret("passphrase", passphrase);

    // Trigger initial sync
    await this.syncNow();
    this.startPeriodicSync();
  }

  async joinAccount({ relayUrl, accountId, salt, passphrase, deviceName }) {
    const { encryptionKey, authToken } = await this.deriveKeys(passphrase, salt);

    // Temporarily save to allow request
    Services.prefs.setStringPref("zen.sync.relay_url", relayUrl);

    // Register device
    const deviceResp = await this.relayRequest(
      "/api/devices",
      "POST",
      { name: deviceName },
      { "X-Account-Id": accountId, "X-Auth-Token": authToken }
    );

    // Save config
    Services.prefs.setStringPref("zen.sync.account_id", accountId);
    Services.prefs.setStringPref("zen.sync.device_id", deviceResp.device_id);
    Services.prefs.setStringPref("zen.sync.device_name", deviceName);
    Services.prefs.setStringPref("zen.sync.salt", salt);
    Services.prefs.setBoolPref("zen.sync.connected", true);

    await this.storeSecret("auth_token", authToken);
    await this.storeSecret("passphrase", passphrase);

    // Trigger initial sync
    await this.syncNow();
    this.startPeriodicSync();
  }

  async renameDevice(newName) {
    const config = await this.getConfig();
    if (!config.deviceId) return;

    await this.relayRequest(`/api/devices/${config.deviceId}`, "PATCH", { name: newName });
    Services.prefs.setStringPref("zen.sync.device_name", newName);
  }

  async syncNow() {
    try {
      const isConfigured = await this.isConfigured();
      if (!isConfigured) return;

      const config = await this.getConfig();
      const passphrase = this.getSecret("passphrase");
      const { encryptionKey } = await this.deriveKeys(passphrase, config.salt);

      // 1. Pull latest remote state
      let remoteState = null;
      let remoteTimestamp = 0;
      try {
        const pullResp = await this.relayRequest("/api/sync/latest");
        if (pullResp && pullResp.ciphertext) {
          remoteState = await this.decryptState(encryptionKey, pullResp.ciphertext, pullResp.nonce);
          remoteTimestamp = pullResp.timestamp || 0;
        }
      } catch (e) {
        console.error("ZenSync: Pull error:", e);
      }

      // 2. Fetch current local state
      const localStateData = lazy.ZenSessionStore.data || {};
      const localTabs = (localStateData.tabs || []).map(t => ({
        zenSyncId: t.zenSyncId || t.id || "",
        zenWorkspace: t.zenWorkspace || "",
        url: t.url || "",
        title: t.title || "",
        pinned: !!t.pinned,
        userContextId: t.userContextId || 0,
        groupId: t.groupId || null,
      }));

      const localState = {
        spaces: localStateData.spaces || [],
        tabs: localTabs,
        groups: localStateData.groups || [],
        folders: localStateData.folders || [],
        split_views: localStateData.splitViewData || [],
        timestamp: Date.now() / 1000
      };

      // 3. Reconcile / Apply remote state if newer
      let applied = false;
      if (remoteState && remoteState.timestamp > (localStateData.lastCollected / 1000 || 0)) {
        // Apply workspaces live
        lazy.ZenSessionStore.setSyncData({
          spaces: remoteState.spaces || [],
          tabs: remoteState.tabs || [],
          groups: remoteState.groups || [],
          folders: remoteState.folders || [],
          splitViewData: remoteState.split_views || remoteState.splitViewData || []
        });

        // Update live workspaces UI
        lazy.ZenWindowSync.propagateWorkspacesToAllWindows(remoteState.spaces || []);
        applied = true;
      }

      // 4. Push local state if we didn't just apply a newer remote state
      if (!applied) {
        const { ciphertext, nonce } = await this.encryptState(encryptionKey, localState);
        await this.relayRequest("/api/sync", "POST", {
          ciphertext,
          nonce,
          device_name: config.deviceName
        });
      }

      Services.prefs.setStringPref("zen.sync.last_sync_time", Date.now().toString());
      Services.prefs.setStringPref("zen.sync.last_sync_details", "Success");
      Services.prefs.setBoolPref("zen.sync.connected", true);
    } catch (e) {
      Services.prefs.setStringPref("zen.sync.last_sync_time", Date.now().toString());
      Services.prefs.setStringPref("zen.sync.last_sync_details", `Error: ${e.message}`);
      Services.prefs.setBoolPref("zen.sync.connected", false);
      throw e;
    }
  }

  async disconnectAccount() {
    this.stopPeriodicSync();

    this.deleteSecret("auth_token");
    this.deleteSecret("passphrase");

    Services.prefs.clearUserPref("zen.sync.relay_url");
    Services.prefs.clearUserPref("zen.sync.account_id");
    Services.prefs.clearUserPref("zen.sync.device_id");
    Services.prefs.clearUserPref("zen.sync.device_name");
    Services.prefs.clearUserPref("zen.sync.salt");
    Services.prefs.clearUserPref("zen.sync.last_sync_time");
    Services.prefs.clearUserPref("zen.sync.last_sync_details");
    Services.prefs.clearUserPref("zen.sync.connected");
  }

  startPeriodicSync() {
    this.stopPeriodicSync();
    // Sync every 5 minutes (300,000 ms)
    this.#syncIntervalId = setInterval(() => {
      this.syncNow().catch(e => console.error("ZenSync: background sync failed:", e));
    }, 300000);
  }

  stopPeriodicSync() {
    if (this.#syncIntervalId) {
      clearInterval(this.#syncIntervalId);
      this.#syncIntervalId = null;
    }
  }

  restartBrowser() {
    Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);
  }
}

export const ZenSyncService = new nsZenSyncService();
