export default {
  async rewrites() {
    return [
      { source: '/',         destination: '/index.html' },
      { source: '/today',    destination: '/index.html' },
      { source: '/tomorrow', destination: '/index.html' },
    ];
  },
};
