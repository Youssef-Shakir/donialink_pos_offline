from odoo import http
from odoo.http import request
from odoo.tools import file_open


class DonialinkPosOffline(http.Controller):

    @http.route('/pos/donialink_sw.js', type='http', auth='none', methods=['GET'])
    def service_worker(self):
        """The offline service worker. Served under /pos/ so it can control the POS page."""
        with file_open('donialink_pos_offline/static/sw/sw.js', 'rb') as f:
            body = f.read()
        return request.make_response(body, headers=[
            ('Content-Type', 'text/javascript; charset=utf-8'),
            ('Cache-Control', 'no-cache'),
            ('Service-Worker-Allowed', '/pos/'),
        ])
