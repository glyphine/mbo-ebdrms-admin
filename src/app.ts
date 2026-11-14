import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

interface PingQuerystring {
  name?: string;
}

fastify.get<{ Querystring: PingQuerystring }>('/', async (request, reply) => {
  const name = request.query.name || 'world';
  return { hello: name };
});

try {
  await fastify.listen({ port: 3000, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

