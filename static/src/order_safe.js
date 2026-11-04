import { patch } from "@web/core/utils/patch";
import { session } from "@web/session";
import IndexedDB from "@point_of_sale/app/models/utils/indexed_db";

/**
 * Order safe: a second copy of every paid order that isn't on the server yet, kept in its
 * own IndexedDB database with "strict" writes (on disk before the write counts as done, so a
 * power cut can't undo it).
 *
 * A copy is only removed once the server has the order (the order got a server id, or
 * sync_from_ui answered for it). Sending a copy again is harmless: the server finds orders by
 * uuid and ignores ones it already has.
 */

const DB_NAME = "donialink_pos_orders";
const STORE = "orders";
const STRICT = { durability: "strict" };

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "uuid" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function run(mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode, mode === "readwrite" ? STRICT : undefined);
        const result = work(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(result.value); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
    });
}

function mine(entry) {
    return entry.configId === odoo.pos_config_id && entry.db === session.db;
}

export const orderSafe = {
    /** Saves (or updates) copies of these paid, not yet sent orders. */
    async save(orders) {
        const entries = orders.map((order) => ({
            uuid: order.uuid,
            configId: odoo.pos_config_id,
            db: session.db,
            name: order.pos_reference || order.name || "",
            savedAt: Date.now(),
            data: JSON.parse(JSON.stringify(order.serialize({ orm: true }))),
        }));
        if (!entries.length) {
            return;
        }
        await run("readwrite", (store) => {
            entries.forEach((e) => store.put(e));
            return {};
        });
    },

    /** Copies kept for this POS. */
    async all() {
        const result = await run("readonly", (store) => {
            const out = {};
            store.getAll().onsuccess = (ev) => (out.value = ev.target.result);
            return out;
        });
        return (result || []).filter(mine);
    },

    async remove(uuids) {
        if (!uuids.length) {
            return;
        }
        await run("readwrite", (store) => {
            uuids.forEach((u) => store.delete(u));
            return {};
        });
    },
};

/** Odoo's own order storage: strict writes too, so a power cut can't undo a saved order. */
patch(IndexedDB.prototype, {
    getNewTransaction(dbStore) {
        try {
            if (!this.db) {
                return false;
            }
            return this.db.transaction(dbStore, "readwrite", STRICT);
        } catch (e) {
            console.info("DATABASE is not ready yet", e);
            if (e.name === "InvalidStateError") {
                this.db = null;
                this._attemptReconnect?.(); // not in older 18.0 builds
            }
            return false;
        }
    },
});
