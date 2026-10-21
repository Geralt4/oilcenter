ALTER TABLE `orders` ADD `coupon_id` integer REFERENCES coupons(id) ON DELETE set null;
--> statement-breakpoint
UPDATE `orders` SET `coupon_id` = (SELECT `id` FROM `coupons` WHERE `coupons`.`code` = `orders`.`coupon_code`) WHERE `coupon_code` IS NOT NULL;
