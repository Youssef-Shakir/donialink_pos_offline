import logging

from odoo import _, api, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class PosOrder(models.Model):
    _inherit = 'pos.order'

    @api.model
    def sync_from_ui(self, orders):
        """An order made on a device whose session was deleted on the server meanwhile.

        Odoo moves orders of a *closed* session to the open session of the same point of sale,
        but a *deleted* session makes sync_from_ui fail with "Record does not exist" at every
        try: the order never reaches the server and the device can't close its register.
        Give such an order the open session of its point of sale, like Odoo does for closed ones.
        Done here, before _process_order: other modules (pos_online_payment) read the session
        in their own _process_order before ours would run.
        """
        for order in orders:
            self._dl_fix_deleted_session(order)
        return super().sync_from_ui(orders)

    @api.model
    def _dl_fix_deleted_session(self, order):
        session_id = order.get('session_id')
        if session_id and not self.env['pos.session'].browse(session_id).exists():
            config_id = order.get('config_id') or self.env.context.get('config_id')
            open_session = self.env['pos.session'].search([
                ('state', 'not in', ('closed', 'closing_control')),
                ('config_id', '=', config_id),
            ], limit=1) if config_id else self.env['pos.session']
            if not open_session:
                raise UserError(_(
                    "The session of order %(order)s no longer exists and this point of sale has no "
                    "open session. Open a session to save the order.", order=order.get('name'),
                ))
            _logger.warning(
                "Session ID %s no longer exists but received order %s (total: %s); saving it in open session %s",
                session_id, order.get('name'), order.get('amount_total'), open_session.name,
            )
            order['session_id'] = open_session.id
