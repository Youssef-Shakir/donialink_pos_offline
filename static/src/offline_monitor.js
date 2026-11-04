import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { ConnectionLostError } from "@web/core/network/rpc";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { offlineState } from "@donialink_pos_offline/offline_data";
import { orderSafe } from "@donialink_pos_offline/order_safe";

/**
 * Server status check, sync, order safety, closing check and the offline badge.
 *
 * The browser's "online" event only says the device has a network, not that the Odoo server
 * answers (Wi-Fi up, internet or VPS down). So the server is checked every minute (every
 * 10 s while offline) and orders are sent as soon as it answers again.
 *
 * Nothing here deletes an order: Odoo's own storage is never cleared, and a copy in the order
 * safe is only removed once the server has that order.
 *
 * The Android app opens the panel by sending the page a "donialink:open" event
 * (also "donialink:sync" and "donialink:refresh").
 */

const PING_ONLINE = 60000;
const PING_OFFLINE = 10000;
const PING_TIMEOUT = 8000;

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) {
        e.className = className;
    }
    if (text !== undefined) {
        e.textContent = text;
    }
    return e;
}

function formatTime(ms) {
    if (!ms) {
        return "—";
    }
    const { DateTime } = luxon;
    return DateTime.fromMillis(ms).toLocaleString(DateTime.DATETIME_SHORT);
}

function errorText(e) {
    return e?.data?.message || e?.message || String(e);
}

/** Paid orders that aren't on the server yet (no server id). */
function unsyncedPaid(pos) {
    return pos.models["pos.order"].filter((o) => o.isUnsyncedPaid);
}

/**
 * Writes these orders to disk right away: Odoo's own storage (normally 200 ms later) and a
 * copy in the order safe. Called the moment an order is paid.
 */
async function protectOrders(pos, orders) {
    orders = orders.filter((o) => o && o.isUnsyncedPaid);
    if (!orders.length) {
        return;
    }
    try {
        pos.data.syncDataWithIndexedDB(pos.data.records);
    } catch (e) {
        console.warn("DoniaLink offline: Odoo storage not written", e);
    }
    try {
        await orderSafe.save(orders);
    } catch (e) {
        console.error("DoniaLink offline: order safe not written", e);
    }
    pos.donialinkOffline?.refreshSafeCount();
}

/** Removes safe copies of orders that now have a server id (the server has them). */
async function cleanSafe(pos) {
    try {
        const done = (await orderSafe.all())
            .filter((e) => typeof pos.models["pos.order"].getBy("uuid", e.uuid)?.id === "number")
            .map((e) => e.uuid);
        await orderSafe.remove(done);
    } catch (e) {
        console.warn("DoniaLink offline: order safe not cleaned", e);
    }
    pos.donialinkOffline?.refreshSafeCount();
}

export class OfflineMonitor {
    constructor(pos) {
        this.pos = pos;
        this.data = pos.data;
        this.online = !offlineState.fromCache;
        this.failures = 0;
        this.syncing = false;
        this.checking = false;
        this.lastSync = 0;
        this.lastError = "";
        this.safeCount = 0;
        this.swStatus = "starting"; // ready / disabled / insecure / unsupported / error
        this.build();
        if (offlineState.enabled) {
            this.registerServiceWorker();
        } else {
            this.removeServiceWorker();
        }

        window.addEventListener("online", () => this.check());
        window.addEventListener("offline", () => this.setOffline());
        window.addEventListener("donialink:open", () => this.open());
        window.addEventListener("donialink:sync", () => this.check(true));
        window.addEventListener("donialink:refresh", () => this.refreshData());
        // App sent to the background / screen off: make sure everything paid is on disk.
        const protectAll = () => protectOrders(this.pos, unsyncedPaid(this.pos));
        window.addEventListener("pagehide", protectAll);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
                protectAll();
            }
        });
        document.documentElement.setAttribute("data-dl-offline", "1"); // tells the app the module is here
        setInterval(() => this.render(), 3000);
        this.refreshSafeCount();
        this.timer = setTimeout(() => this.check(), offlineState.fromCache ? 3000 : 5000);
        this.render();
    }

    get isOnline() {
        return this.online && !this.data.network.offline;
    }

    /** Paid orders not on the server yet. */
    get pending() {
        return unsyncedPaid(this.pos).length;
    }

    /** Orders waiting: Odoo's own list, or the order safe if it holds more (e.g. after a crash). */
    get waiting() {
        return Math.max(this.pending, this.safeCount);
    }

    /** Other changes Odoo queued while offline. */
    get otherPending() {
        return this.data.network.unsyncData.length;
    }

    async refreshSafeCount() {
        try {
            this.safeCount = (await orderSafe.all()).length;
        } catch {
            // keep the last count
        }
        this.render();
    }

    // ---------- offline start (service worker) ----------

    async registerServiceWorker() {
        if (!("serviceWorker" in navigator)) {
            this.swStatus = "unsupported";
            return;
        }
        if (!window.isSecureContext) {
            this.swStatus = "insecure";
            return;
        }
        try {
            await navigator.serviceWorker.register("/pos/donialink_sw.js", { scope: "/pos/" });
            const reg = await navigator.serviceWorker.ready;
            // Files loaded before the worker was in control (first start) are saved now.
            const files = performance.getEntriesByType("resource").map((e) => e.name);
            reg.active?.postMessage({ type: "warm", page: location.href, files });
            this.swStatus = "ready";
        } catch (e) {
            console.warn("DoniaLink offline: service worker not registered", e);
            this.swStatus = "error";
        }
        this.render();
    }

    /** Offline mode switched off for this POS: forget the saved page and files (not orders). */
    async removeServiceWorker() {
        this.swStatus = "disabled";
        try {
            if ("serviceWorker" in navigator) {
                for (const reg of await navigator.serviceWorker.getRegistrations()) {
                    const workers = [reg.active, reg.waiting, reg.installing];
                    if (workers.some((w) => w?.scriptURL.includes("/pos/donialink_sw.js"))) {
                        await reg.unregister();
                    }
                }
            }
            if (window.caches) {
                for (const name of await caches.keys()) {
                    if (name.startsWith("dl-pos-")) {
                        await caches.delete(name);
                    }
                }
            }
        } catch (e) {
            console.warn("DoniaLink offline: offline files not removed", e);
        }
    }

    // ---------- server check and sync ----------

    async ping() {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
        try {
            const res = await fetch("/web/webclient/version_info", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: {} }),
                signal: ctrl.signal,
                cache: "no-store",
            });
            return res.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    setOnline() {
        if (!this.isOnline) {
            this.data.network.warningTriggered = false; // show Odoo's offline popup again next time
        }
        this.failures = 0;
        this.online = true;
        this.data.network.offline = false;
    }

    setOffline() {
        this.online = false;
        this.data.network.offline = true; // POS calls fail at once instead of waiting
        this.render();
    }

    async check(forceSync = false) {
        clearTimeout(this.timer);
        if (!this.checking) {
            this.checking = true;
            try {
                if (await this.ping()) {
                    const wasOffline = !this.isOnline;
                    this.setOnline();
                    if (wasOffline || forceSync || this.waiting || this.otherPending) {
                        await this.sync();
                    }
                } else {
                    this.failures++;
                    // One slow answer isn't enough to switch to offline mode.
                    if (this.failures >= 2 || !navigator.onLine || offlineState.fromCache) {
                        this.setOffline();
                    }
                }
            } finally {
                this.checking = false;
            }
        }
        this.render();
        this.timer = setTimeout(() => this.check(), this.isOnline ? PING_ONLINE : PING_OFFLINE);
    }

    async sync() {
        if (this.syncing) {
            return;
        }
        this.syncing = true;
        this.lastError = "";
        this.render();
        try {
            await this.data.syncData();
            const paid = unsyncedPaid(this.pos);
            if (paid.length) {
                this.pos.addPendingOrder(paid.map((o) => o.id)); // make sure Odoo sends every one
            }
            await this.pos.pushOrderMutex.exec(() => this.pos.syncAllOrders());
            await this.sendSafeCopies();
            await this.refreshSafeCount();
            if (this.waiting) {
                this.lastError ||= _t("Some orders could not be sent yet. They will be tried again.");
            } else {
                this.lastSync = Date.now();
            }
        } catch (e) {
            this.lastError = errorText(e);
            if (e instanceof ConnectionLostError) {
                this.setOffline();
            }
        } finally {
            this.syncing = false;
            this.render();
        }
    }

    /**
     * Order safe → server. A copy whose order now has a server id is done. A copy whose order
     * isn't in the POS any more (lost from Odoo's storage) is sent as it is; the server ignores
     * it if it already has that order. Copies of orders still waiting in the POS are left to
     * Odoo's own sync.
     */
    async sendSafeCopies() {
        const done = [];
        try {
            for (const entry of await orderSafe.all()) {
                const order = this.pos.models["pos.order"].getBy("uuid", entry.uuid);
                if (order && typeof order.id === "number") {
                    done.push(entry.uuid);
                    continue;
                }
                if (order) {
                    continue;
                }
                try {
                    await this.data.call("pos.order", "sync_from_ui", [[entry.data]], {
                        context: this.pos.getSyncAllOrdersContext([]),
                    });
                    done.push(entry.uuid);
                } catch (e) {
                    if (e instanceof ConnectionLostError) {
                        throw e;
                    }
                    this.lastError = `${entry.name}: ${errorText(e)}`;
                    console.error("DoniaLink offline: saved order not accepted by the server", entry, e);
                }
            }
        } finally {
            await orderSafe.remove(done).catch((e) => console.warn("DoniaLink offline: order safe not cleaned", e));
        }
    }

    /**
     * Closing the register: only with the server answering and every order on the server,
     * so no order made offline is left behind on the device.
     */
    async readyToClose() {
        if (!(await this.ping())) {
            this.setOffline();
            this.alert(
                _t("Closing needs internet"),
                _t("The Odoo server can't be reached. Orders made offline are safe on this device. Close the register when the connection is back.")
            );
            return false;
        }
        this.setOnline();
        await this.sync();
        if (this.waiting) {
            this.alert(
                _t("Orders not sent yet"),
                _t("%s orders are not on the server yet. Close the register after they are sent (Offline & sync → Sync now).", this.waiting)
            );
            return false;
        }
        return true;
    }

    /** Reload the POS so it loads fresh data from the server (and saves it for offline use). */
    async refreshData() {
        await this.check(true);
        if (!this.isOnline) {
            this.notify(_t("The server can't be reached. Connect to the internet and try again."));
            return;
        }
        if (this.waiting) {
            this.notify(_t("Some orders are still waiting to be sent. Refresh after they are sent."));
            return;
        }
        this.close();
        setTimeout(() => location.reload(), 500); // let Odoo finish saving its local data
    }

    notify(message) {
        this.pos.notification.add(message, { type: "warning" });
    }

    alert(title, body) {
        this.pos.dialog.add(AlertDialog, { title, body });
    }

    // ---------- badge and panel ----------

    build() {
        this.pill = el("button", "dl-off-pill");
        this.pill.type = "button";
        this.pill.addEventListener("click", () => this.open());

        this.backdrop = el("div", "dl-off-backdrop");
        this.backdrop.addEventListener("click", (ev) => {
            if (ev.target === this.backdrop) {
                this.close();
            }
        });
        const panel = el("div", "dl-off-panel");
        panel.appendChild(el("div", "dl-off-title", _t("Offline & sync")));
        const rows = el("div", "dl-off-rows");
        const row = (label) => {
            const r = el("div", "dl-off-row");
            r.appendChild(el("span", "dl-off-label", label));
            const v = el("span", "dl-off-value");
            r.appendChild(v);
            rows.appendChild(r);
            return v;
        };
        this.vServer = row(_t("Server"));
        this.vPending = row(_t("Orders waiting to be sent"));
        this.vSafe = row(_t("Orders kept safe on this device"));
        this.vOther = row(_t("Other changes waiting"));
        this.vLastSync = row(_t("Last sync"));
        this.vSaved = row(_t("POS data loaded"));
        this.vOfflineStart = row(_t("Open without internet"));
        panel.appendChild(rows);
        this.vError = el("div", "dl-off-error");
        panel.appendChild(this.vError);

        const buttons = el("div", "dl-off-buttons");
        this.bSync = el("button", "btn btn-primary", _t("Sync now"));
        this.bSync.addEventListener("click", () => this.check(true));
        this.bRefresh = el("button", "btn btn-secondary", _t("Refresh data"));
        this.bRefresh.addEventListener("click", () => this.refreshData());
        const bClose = el("button", "btn btn-light", _t("Close"));
        bClose.addEventListener("click", () => this.close());
        buttons.append(this.bSync, this.bRefresh, bClose);
        panel.appendChild(buttons);
        this.backdrop.appendChild(panel);

        document.body.append(this.pill, this.backdrop);
    }

    open() {
        this.backdrop.classList.add("dl-open");
        this.refreshSafeCount();
    }

    close() {
        this.backdrop.classList.remove("dl-open");
    }

    render() {
        const online = this.isOnline;
        const waiting = this.waiting;
        const other = this.otherPending;

        // Badge: only when there is something to say.
        let text = "";
        let tone = "";
        if (this.syncing) {
            text = _t("Syncing…");
            tone = "sync";
        } else if (!online) {
            text = waiting ? _t("Offline · %s orders waiting", waiting) : _t("Offline");
            tone = "off";
        } else if (waiting) {
            text = _t("%s orders waiting to be sent", waiting);
            tone = "wait";
        } else if (offlineState.fromCache) {
            text = _t("Back online · tap to refresh data");
            tone = "wait";
        }
        this.pill.textContent = text;
        this.pill.className = "dl-off-pill" + (text ? " dl-show dl-" + tone : "");

        if (!this.backdrop.classList.contains("dl-open")) {
            return;
        }
        this.vServer.textContent = this.syncing
            ? _t("Syncing…")
            : online
            ? _t("Online")
            : _t("Not reachable (working offline)");
        this.vServer.className = "dl-off-value " + (online ? "dl-ok" : "dl-bad");
        this.vPending.textContent = String(this.pending);
        this.vPending.className = "dl-off-value " + (this.pending ? "dl-bad" : "dl-ok");
        this.vSafe.textContent = String(this.safeCount);
        this.vOther.textContent = String(other);
        this.vOther.parentElement.style.display = other ? "" : "none";
        this.vLastSync.textContent = formatTime(this.lastSync);
        this.vSaved.textContent =
            formatTime(offlineState.savedAt) + (offlineState.fromCache ? " " + _t("(saved copy)") : "");
        this.vOfflineStart.textContent = {
            starting: _t("Preparing…"),
            ready: _t("Ready"),
            disabled: _t("Off (POS setting)"),
            insecure: _t("Needs HTTPS on the Odoo server"),
            unsupported: _t("Not supported by this browser"),
            error: _t("Not available"),
        }[this.swStatus];
        this.vOfflineStart.className = "dl-off-value " + (this.swStatus === "ready" ? "dl-ok" : "dl-bad");
        this.vError.textContent = this.lastError;
        this.bSync.disabled = this.syncing;
    }
}

patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        // Orders restored from Odoo's storage at start: make sure the safe has them too.
        await protectOrders(this, unsyncedPaid(this));
        this.donialinkOffline = new OfflineMonitor(this);
    },

    /**
     * The start ends with deviceSync.readDataFromServer (open orders of other devices): offline
     * it fails and the POS never finishes starting. Skip it then; it runs again when online.
     * Patched on the instance: older 18.0 builds have no deviceSync.
     */
    async processServerData() {
        const result = await super.processServerData(...arguments);
        const deviceSync = this.deviceSync;
        if (deviceSync?.readDataFromServer) {
            const read = deviceSync.readDataFromServer.bind(deviceSync);
            deviceSync.readDataFromServer = async (...args) => {
                try {
                    return await read(...args);
                } catch (error) {
                    if (error instanceof ConnectionLostError) {
                        return;
                    }
                    throw error;
                }
            };
        }
        return result;
    },

    /**
     * Odoo calls this when an order is paid, one line before it sets state = "paid": save the
     * order to disk right after that line (microtask), not 200 ms later.
     */
    addPendingOrder(orderIds, remove = false) {
        const result = super.addPendingOrder(...arguments);
        if (!remove) {
            const orders = orderIds.map((id) => this.models["pos.order"].get(id));
            Promise.resolve().then(() => protectOrders(this, orders));
        }
        return result;
    },

    /** Every paid order is on disk before it is sent; the safe copy goes once the server has it. */
    async syncAllOrders() {
        await protectOrders(this, unsyncedPaid(this));
        const result = await super.syncAllOrders(...arguments);
        await cleanSafe(this);
        return result;
    },

    /** "Close Register" from the menu: check internet and unsent orders first. */
    async closeSession() {
        if (this.donialinkOffline && !(await this.donialinkOffline.readyToClose())) {
            return;
        }
        return await super.closeSession(...arguments);
    },

    /**
     * Offline start: sibling variants can't be fetched; they load at the next online start.
     * Older 18.0 builds fetch them in processProductAttributes, newer ones in ...ByProducts.
     */
    async processProductAttributes() {
        try {
            return await super.processProductAttributes(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return;
            }
            throw error;
        }
    },

    async processProductAttributesByProducts() {
        try {
            return await super.processProductAttributesByProducts(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return;
            }
            throw error;
        }
    },

    /** Offline start: pricelist items of products kept in IndexedDB load at the next online start. */
    async _loadMissingPricelistItems() {
        try {
            return await super._loadMissingPricelistItems(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return;
            }
            throw error;
        }
    },
});

/** The closing popup's Close button: same check again (the connection may have dropped meanwhile). */
patch(ClosePosPopup.prototype, {
    async closeSession() {
        if (this.pos.donialinkOffline && !(await this.pos.donialinkOffline.readyToClose())) {
            return;
        }
        return await super.closeSession(...arguments);
    },
});

// PosStore.setup asks the server whether the user may create products; offline: no.
patch(user, {
    async checkAccessRight() {
        try {
            return await super.checkAccessRight(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return false;
            }
            throw error;
        }
    },
});
