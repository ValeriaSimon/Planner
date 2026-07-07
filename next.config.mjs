export default {
  async rewrites() {
    return [
      { source: '/',         destination: '/index.html' },
      { source: '/today',    destination: '/today.html' },
      { source: '/tomorrow', destination: '/tomorrow.html' },
    ];
  },
};
