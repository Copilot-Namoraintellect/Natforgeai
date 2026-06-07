-- Add 2FA foundation fields to users table
ALTER TABLE `users` ADD COLUMN `twoFactorEnabled` boolean DEFAULT false NOT NULL;
ALTER TABLE `users` ADD COLUMN `twoFactorMethod` varchar(20);
ALTER TABLE `users` ADD COLUMN `twoFactorVerifiedAt` timestamp;
