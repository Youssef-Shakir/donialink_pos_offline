from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    # Loaded into the POS with the other pos.config fields (all fields are loaded).
    dl_offline_mode = fields.Boolean(
        string="Offline Mode",
        default=True,
        help="Open this point of sale and sell without internet. Orders made offline are sent "
             "when the server can be reached again. Needs HTTPS.",
    )
