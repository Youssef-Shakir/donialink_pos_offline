import { patch } from "@web/core/utils/patch";
import { session } from "@web/session";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError, RPCError } from "@web/core/network/rpc";
import { PosData } from "@point_of_sale/app/models/data_service";
import { BarcodeParser } from "@barcodes/js/barcode_parser";

/**
 * Keeps the POS data (pos.session/load_data) on the device and uses it when the server
 * can't be reached at start, so the POS opens offline. Orders made offline are already
 * kept by Odoo in IndexedDB and sent again at the next start / when back online.
 */

const DB_NAME = "donialink_pos_offline";
const STORE = "load_data";

/** Shared with offline_monitor.js. */
export const offlineState = {
    enabled: true, // "Offline mode" setting of this POS (pos.config.dl_offline_mode)
    fromCache: false, // this start used the saved data (server not reachable)
    savedAt: 0, // when the data in use was loaded from the server (ms)
};

function offlineModeOn(loadData) {
    const config = loadData?.["pos.config"]?.data?.[0];
    return Boolean(config?.dl_offline_mode);
}

function cacheKey() {
    return `${location.host}|${session.db}|config_${odoo.pos_config_id}`;
}

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveLoadData(value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, cacheKey());
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function deleteLoadData() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(cacheKey());
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

/**
 * Copy of load_data without orders, order lines and payments. Orders are kept by Odoo (and by
 * the order safe) on their own; an old copy of them here would bring back orders that were
 * paid or deleted since, as if they were still open.
 */
function withoutOrders(response, dynamicModels) {
    const copy = structuredClone(response);
    for (const model of dynamicModels) {
        if (copy[model]) {
            copy[model].data = [];
        }
    }
    return copy;
}

async function readLoadData() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(cacheKey());
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

patch(PosData.prototype, {
    async loadInitialData() {
        try {
            const response = await this.orm.call("pos.session", "load_data", [
                odoo.pos_session_id,
                PosData.modelToLoad,
            ]);
            offlineState.enabled = offlineModeOn(response);
            if (offlineState.enabled) {
                offlineState.savedAt = Date.now();
                // Copy now: the POS changes the response while it loads it.
                saveLoadData({
                    savedAt: offlineState.savedAt,
                    sessionId: odoo.pos_session_id,
                    data: withoutOrders(response, this.opts.dynamicModels),
                }).catch((e) => console.warn("DoniaLink offline: POS data not saved", e));
            } else {
                deleteLoadData().catch(() => {});
            }
            return response;
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                const saved = await readLoadData().catch(() => null);
                if (saved && offlineModeOn(saved.data)) {
                    console.info("DoniaLink offline: server not reachable, using POS data saved at", new Date(saved.savedAt));
                    this.network.offline = true;
                    offlineState.fromCache = true;
                    offlineState.savedAt = saved.savedAt;
                    return saved.data;
                }
            }
            // Same message as Odoo's own loadInitialData.
            let message = _t("An error occurred while loading the Point of Sale: \n");
            if (error instanceof RPCError) {
                message += error.data.message;
            } else {
                message += error.message;
            }
            window.alert(message);
        }
    },

    /** Offline start: records missing from the saved data can't be fetched; carry on without them. */
    async missingRecursive(recordMap, idsMap = {}, acc = {}) {
        try {
            return await super.missingRecursive(recordMap, idsMap, acc);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return acc;
            }
            throw error;
        }
    },
});

/**
 * The barcode service reads the barcode nomenclature from the server while the POS starts and
 * waits for it: offline that read fails and the POS never finishes starting. Keep the last
 * nomenclature on the device and use it when the server can't be reached.
 */
function nomenclatureKey(id) {
    return `donialink_pos_offline|${location.host}|${session.db}|nomenclature_${id}`;
}

patch(BarcodeParser, {
    async fetchNomenclature(orm, id) {
        try {
            const nomenclature = await super.fetchNomenclature(orm, id);
            try {
                localStorage.setItem(nomenclatureKey(id), JSON.stringify(nomenclature));
            } catch {
                // storage full or blocked: offline start just won't have barcode rules
            }
            return nomenclature;
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            let saved = null;
            try {
                saved = JSON.parse(localStorage.getItem(nomenclatureKey(id)));
            } catch {
                // ignore: handled below
            }
            // Never saved yet: start without barcode rules rather than not at all.
            return saved || { id, name: "", upc_ean_conv: "always", rules: [] };
        }
    },
});
