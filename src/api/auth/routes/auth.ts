export default {
  routes: [
    {
      method: 'POST',
      path: '/otp/send',
      handler: 'auth.sendOtp',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/otp/verify',
      handler: 'auth.verifyOtp',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/register',
      handler: 'auth.register',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/check-cin',
      handler: 'auth.checkCin',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/otp/login',
      handler: 'auth.login',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/profile/me',
      handler: 'auth.me',
      config: { auth: false },
    },
    {
      method: 'PUT',
      path: '/profile/me',
      handler: 'auth.updateMe',
      config: { auth: false },
    },
  ],
};
