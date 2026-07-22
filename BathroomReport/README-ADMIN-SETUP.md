# Secure FlushPanel setup

Upload `flushpanel.html` and `locations.js` to the same GitHub repository folder.

## One-time Firebase setup

1. In Firebase Authentication, enable Email/Password sign-in.
2. Create your administrator user in Authentication.
3. Copy that user's UID.
4. In Firestore, create collection `admins`, then create a document whose ID is that UID.
5. Give the document this field: `enabled: true`.
6. Update your existing Firestore rules so admin reads/writes use the `isAdmin()` check. The included rules file is an example; merge it with your current public-app rules rather than replacing them blindly.

The login screen alone is not security. Firestore rules must also enforce administrator access.
