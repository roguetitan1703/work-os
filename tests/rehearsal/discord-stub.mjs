// A stand-in for Discord's command registration API during the cut-over rehearsal (step 5): the app runs with
// DISCORD_API_BASE=http://127.0.0.1:<port> and PUTs its commands here. Answers the commands back with ids, and logs
// one line per request (method and path only).
import http from 'node:http';

const port = Number(process.argv[2] || 4403);
let n = 0;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      console.log(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT' && /\/applications\/\d+\/guilds\/\d+\/commands$/.test(req.url)) {
        const cmds = JSON.parse(body || '[]');
        res.end(JSON.stringify(cmds.map(c => ({ id: String(900000000000000000 + ++n), ...c }))));
      } else if (req.method === 'GET' && /\/commands$/.test(req.url)) res.end('[]');
      else {
        res.statusCode = 404;
        res.end('{"message":"stub: not here"}');
      }
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`discord stub on ${port}`));
