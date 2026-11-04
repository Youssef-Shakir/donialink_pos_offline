import { patch } from "@web/core/utils/patch";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderLineRefund } from "@point_of_sale/app/models/pos_order_line_refund";

/**
 * Refunds offline. The ticket screen keeps the lines to refund in the refunded order's
 * uiState.lineToRefund as PosOrderLineRefund objects, and each one holds all the POS records
 * (`models`). Odoo saves the uiState of every order not on the server yet with JSON.stringify,
 * so refunding an order paid offline failed with "cyclic object value" / "circular structure".
 * Online the refunded order is already on the server and isn't saved, so it never showed.
 *
 * Save only the plain fields, and make PosOrderLineRefund objects again when the order is
 * read back from the device.
 */
patch(PosOrder.prototype, {
    serializeState() {
        const state = super.serializeState(...arguments);
        const lineToRefund = {};
        for (const [uuid, detail] of Object.entries(state.lineToRefund || {})) {
            lineToRefund[uuid] = {
                uuid: detail.uuid,
                line_uuid: detail.line_uuid,
                destination_order_uuid: detail.destination_order_uuid,
                qty: detail.qty,
            };
        }
        return { ...state, lineToRefund };
    },

    setupState(vals) {
        super.setupState(...arguments);
        const lineToRefund = {};
        for (const [uuid, detail] of Object.entries(this.uiState?.lineToRefund || {})) {
            lineToRefund[uuid] =
                detail instanceof PosOrderLineRefund ? detail : new PosOrderLineRefund(detail, this.models);
        }
        this.uiState.lineToRefund = lineToRefund;
    },
});
