window.GAME_CONFIG = {
  // Backend realtime: configurato per il dominio ZeroLegend su Ubuntu.
  // Il server Node.js (zerogsst) gira su localhost:3001 e viene esposto tramite Nginx reverse proxy.
  GAME_SERVER_URL: 'wss://zerothelegend.gamer.gd',
  AUTO_DISCOVER_WS: true,
  WS_CONFIG_URL: '/auth/ws-config.php',
  ALLOW_SAME_ORIGIN_WS: false,
  AUTH_API_URL: '/auth/auth.php',
  ALLOW_GUEST: false,
  PAYMENT_SUCCESS_URL: '/payment-success.html'
};