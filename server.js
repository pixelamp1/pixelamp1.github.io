const querystring = require('querystring');
const Redis = require('ioredis');
const socketIo = require('socket.io');
const dogNames = require('dog-names');
const axios = require('axios');

const config = require('./config');
const pub = require('./lib/pub');
const sub = require('./lib/sub');
const redis = require('./lib/redis');
const slackHandler = require('./lib/slackHandler');

const messagesChannel = 'chat-messages';
const chatHistory = 'chat-history';
const messagesCounter = 'chat-counter:messages';
const domainsSet = 'chat-domains';
const chattersCounter = 'chat-chatters';
const pageViewsCounter = 'chat-views';
const liveChattersCounter = 'chat-live';

slackHandler.listen(3055, '0.0.0.0');

const io = socketIo(3050);

const domains = {};
const stats = new Set();

async function getStats() {
	return {
		messages: await redis.get(messagesCounter) || 0,
		domains: await redis.scard(domainsSet) || 0,
		chatters: await redis.get(chattersCounter) || 0,
		liveChatters: await redis.get(liveChattersCounter) || 0,
		pageViews: await redis.get(pageViewsCounter) || 0
	};
}

setInterval(async () => {
	const data = await getStats();

	for (const socket of stats) {
		socket.emit('stats', data);
	}
}, 1000);

io.on('connection', socket => {
	socket.on('subscribe-stats', async () => {
		socket.emit('stats', await getStats());
		stats.add(socket);
	});

	socket.on('disconnect', () => {
		stats.delete(socket);
	});

	socket.on('init', async (domain, isNewVisitor) => {
		await redis.incr(pageViewsCounter);
		await redis.incr(liveChattersCounter);
		await redis.sadd(domainsSet, domain);

		if (isNewVisitor === true) {
			await redis.incr(chattersCounter);
		}

		if (!(domains[domain] instanceof Set)) {
			domains[domain] = new Set();
		}

		domains[domain].add(socket);

		let name = dogNames.allRandom();

		socket.emit('name', name);

		socket.on('message', async text => {
			if (text.startsWith('/')) {
				const commandHandlers = {
					name(_name = '') {
						name = _name.trim().slice(0, 9);

						if (name.length < 2) {
							return;
						}

						socket.emit('name', name);
					}
				};

				const [command, ...args] = text.slice(1).split(' ');

				if (command in commandHandlers) {
					commandHandlers[command](...args);
				}

				return;
			}

			const message = {
				name,
				text
			};

			await pub.publish(messagesChannel, JSON.stringify({
				message,
				domain
			}));

			await redis.lpush(`${chatHistory}:${domain}`, JSON.stringify(message));

			await redis.incr(messagesCounter);

			await axios.post(process.env.WEBHOOK, {
				text: `${name}: ${text}`
			});
		});

		socket.on('disconnect', async () => {
			domains[domain].delete(socket);
			await redis.decr(liveChattersCounter);
		});

		const rawMessages = await redis.lrange(`${chatHistory}:${domain}`, 0, -1);

		rawMessages.reverse();

		for (const rawMessage of rawMessages) {
			socket.emit('message', JSON.parse(rawMessage));
		}
	});
});

sub.on('message', (channel, rawMessage) => {
	const {message, domain} = JSON.parse(rawMessage);

	if (domains[domain] instanceof Set) {
		for (const socket of domains[domain]) {
			socket.emit('message', message);
		}
	}
});
