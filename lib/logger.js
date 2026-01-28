'use strict';

const {
	createLogger,
	format,
	transports
} = require('winston');

const {
	combine,
	timestamp,
	label,
	printf
} = format;

const myFormat = printf(info => {
	return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
});

const NewLogger = (options = {}) => {
	if (!options['label']) options['label'] = 'Unknown';

	return createLogger({
		format: combine(
			label({
				label: options.label
			}),
			timestamp(),
			myFormat
		),
		transports: [new transports.Console()]
	});
};

module.exports = {
	NewLogger
};