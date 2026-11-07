-- R10-X canonical package. Generated offline; NOT EXECUTED. No activation data.
CREATE TABLE `autonomy_activations` (
	`scope_key` varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` bigint unsigned NOT NULL,
	`state_json` json NOT NULL,
	CONSTRAINT `autonomy_activations_scope_key` PRIMARY KEY(`scope_key`)
);

--> statement-breakpoint
CREATE TABLE `autonomy_activation_audit` (
	`scope_key` varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` bigint unsigned NOT NULL,
	`audit_json` json NOT NULL,
	CONSTRAINT `autonomy_activation_audit_scope_key_version_pk` PRIMARY KEY(`scope_key`,`version`)
);

--> statement-breakpoint
CREATE TABLE `autonomy_canary_reservations` (
	`scope_key` varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`action_id` varchar(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	CONSTRAINT `autonomy_canary_reservations_scope_key_action_id_pk` PRIMARY KEY(`scope_key`,`action_id`)
);
