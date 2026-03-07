export default {
  routes: [
    {
      method: 'POST',
      path: '/otp/send',
      handler: 'otp.send',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/otp/verify',
      handler: 'otp.verify',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/register',
      handler: 'registration.register',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/check-cin',
      handler: 'registration.checkCin',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/check-email',
      handler: 'registration.checkEmail',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/check-referral',
      handler: 'registration.checkReferralCode',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/otp/login',
      handler: 'otp.login',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/profile/me',
      handler: 'profile.me',
      config: { auth: false },
    },
    {
      method: 'PUT',
      path: '/profile/me',
      handler: 'profile.updateMe',
      config: { auth: false },
    },
  ],
};
