{
    "name": "DoniaLink POS Offline",
    "version": "18.0.1.0.4",
    "category": "Sales/Point of Sale",
    "summary": "Open the Point of Sale without internet, sell offline and sync when back online",
    "description": """
Keeps the Point of Sale page, its files and its data on the device, so the POS also opens
when the Odoo server can't be reached. Orders made offline are kept on the device and sent
as soon as the server answers again. A status badge shows offline / waiting orders, with
Sync now and Refresh data buttons.

- Offline Mode setting per point of sale (Point of Sale > Settings > PoS Interface).
- Paid orders are written to disk at once, with a second copy kept until the server has them,
  so a power cut or a killed app doesn't lose them.
- Closing the register needs the server to answer and every order to be sent.

Needs HTTPS (browsers only allow the offline page cache on secure sites).
    """,
    "author": "Yousif Shakir (DoniaLink)",
    "website": "https://donialink.com",
    "license": "LGPL-3",
    "depends": ["point_of_sale"],
    "data": [
        "views/res_config_settings_views.xml",
    ],
    "assets": {
        "point_of_sale._assets_pos": [
            "donialink_pos_offline/static/src/**/*",
        ],
    },
    "installable": True,
}
