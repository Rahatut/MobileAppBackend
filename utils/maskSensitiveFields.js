// maskSensitiveFields.js
// Utility to mask sensitive fields in user/ride objects

function maskPhone(phone) {
  if (!phone) return '';
  return phone.replace(/(\d{2})\d{3}(\d{3})/, '$1***$2');
}

function maskEmail(email) {
  if (!email) return '';
  const [user, domain] = email.split('@');
  return user.slice(0,2) + '***@' + domain;
}

function maskUser(user) {
  return {
    ...user,
    phone: maskPhone(user.phone),
    email: maskEmail(user.email),
  };
}

function maskRide(ride) {
  // Add masking logic for ride if needed
  return { ...ride };
}

module.exports = { maskUser, maskRide };
