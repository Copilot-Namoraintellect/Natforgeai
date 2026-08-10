-- Add dedicated account-email verification and login-2FA tracking.
-- Back-fill from the legacy twoFactorVerifiedAt field so existing verified users are not forced to re-verify.

ALTER TABLE `users` ADD COLUMN `emailVerifiedAt` timestamp NULL;
ALTER TABLE `users` ADD COLUMN `lastTwoFactorVerifiedAt` timestamp NULL;

ALTER TABLE `two_factor_challenges` ADD COLUMN `purpose` varchar(50) NOT NULL DEFAULT 'login_2fa';

UPDATE `users`
SET `emailVerifiedAt` = `twoFactorVerifiedAt`,
    `lastTwoFactorVerifiedAt` = `twoFactorVerifiedAt`
WHERE `twoFactorVerifiedAt` IS NOT NULL;
