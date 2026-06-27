/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const { classes: Cc, interfaces: Ci } = Components;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
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

  #getStringPref(pref, defaultValue = "") {
    try {
      return Services.prefs.getStringPref(pref);
    } catch (e) {
      return defaultValue;
    }
  }

  #getBoolPref(pref, defaultValue = false) {
    try {
      return Services.prefs.getBoolPref(pref);
    } catch (e) {
      return defaultValue;
    }
  }

  async isConfigured() {
    const accountId = this.#getStringPref("zen.sync.account_id");
    const deviceId = this.#getStringPref("zen.sync.device_id");
    return !!(accountId && deviceId);
  }

  async getConfig() {
    return {
      relayUrl: this.#getStringPref("zen.sync.relay_url"),
      accountId: this.#getStringPref("zen.sync.account_id"),
      deviceId: this.#getStringPref("zen.sync.device_id"),
      deviceName: this.#getStringPref("zen.sync.device_name"),
      salt: this.#getStringPref("zen.sync.salt"),
    };
  }

  async getStatus() {
    const lastSyncTime = this.#getStringPref("zen.sync.last_sync_time");
    const lastSyncDetails = this.#getStringPref("zen.sync.last_sync_details");
    const connected = this.#getBoolPref("zen.sync.connected", false);
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

    return { encryptionKey, authToken, authBits };
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
    const relayUrl = this.#getStringPref("zen.sync.relay_url");
    if (!relayUrl) throw new Error("Relay URL not configured");

    const accountId = this.#getStringPref("zen.sync.account_id");
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

    const { encryptionKey, authToken, authBits } = await this.deriveKeys(passphrase, saltB64);

    // Compute hash for auth token (sha256 of auth token + salt)
    const saltBytesText = new TextEncoder().encode("zensync_server_salt");
    const concatBytes = new Uint8Array(authBits.byteLength + saltBytesText.byteLength);
    concatBytes.set(new Uint8Array(authBits), 0);
    concatBytes.set(saltBytesText, authBits.byteLength);

    const authHashBuf = await crypto.subtle.digest("SHA-256", concatBytes);
    const authHash = Array.from(new Uint8Array(authHashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Temporarily save relay URL to allow relayRequest to resolve
    Services.prefs.setStringPref("zen.sync.relay_url", relayUrl);

    // 1. Register account
    const regResp = await this.relayRequest("/api/register", "POST", {
      auth_hash: authHash,
      salt: saltB64,
      token: token || "",
    });

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

  async listDevices() {
    const config = await this.getConfig();
    if (!config.accountId) return [];
    return this.relayRequest("/api/devices", "GET");
  }

  async deleteDevice(deviceId) {
    const config = await this.getConfig();
    if (!config.accountId) return;
    return this.relayRequest(`/api/devices/${deviceId}`, "DELETE");
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
        const pullResp = await this.relayRequest("/api/blobs", "GET", null, {
          "X-Device-Id": config.deviceId,
        });
        if (pullResp && pullResp.length > 0) {
          // Find the blob with the highest timestamp
          let latestBlob = pullResp[0];
          for (const blob of pullResp) {
            if (blob.timestamp > latestBlob.timestamp) {
              latestBlob = blob;
            }
          }
          remoteState = await this.decryptState(encryptionKey, latestBlob.ciphertext, latestBlob.nonce);
          remoteTimestamp = latestBlob.timestamp || 0;
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
        await this.relayRequest("/api/blobs", "POST", {
          version: 1,
          ciphertext,
          nonce,
        }, {
          "X-Device-Id": config.deviceId,
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
    try {
      this.stopPeriodicSync();
    } catch (e) {
      console.error("ZenSync: error stopping sync:", e);
    }

    try {
      this.deleteSecret("auth_token");
    } catch (e) {
      console.error("ZenSync: error deleting auth_token:", e);
    }
    try {
      this.deleteSecret("passphrase");
    } catch (e) {
      console.error("ZenSync: error deleting passphrase:", e);
    }

    const prefsToClear = [
      "zen.sync.relay_url",
      "zen.sync.account_id",
      "zen.sync.device_id",
      "zen.sync.device_name",
      "zen.sync.salt",
      "zen.sync.last_sync_time",
      "zen.sync.last_sync_details",
      "zen.sync.connected"
    ];

    for (const pref of prefsToClear) {
      try {
        if (Services.prefs.prefHasUserValue(pref)) {
          Services.prefs.clearUserPref(pref);
        }
      } catch (e) {
        console.error(`ZenSync: error clearing pref ${pref}:`, e);
      }
    }
  }

  async deleteAccountFromServer() {
    const config = await this.getConfig();
    if (!config.accountId) return;

    try {
      await this.relayRequest("/api/account", "DELETE");
    } catch (e) {
      console.error("ZenSync: error deleting account from server:", e);
      throw e;
    }

    await this.disconnectAccount();
  }

  startPeriodicSync() {
    this.stopPeriodicSync();
    // Sync every 5 minutes (300,000 ms)
    this.#syncIntervalId = lazy.setInterval(() => {
      this.syncNow().catch(e => console.error("ZenSync: background sync failed:", e));
    }, 300000);
  }

  stopPeriodicSync() {
    if (this.#syncIntervalId) {
      lazy.clearInterval(this.#syncIntervalId);
      this.#syncIntervalId = null;
    }
  }

  restartBrowser() {
    Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);
  }
}

export const ZenSyncService = new nsZenSyncService();
