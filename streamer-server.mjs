import WebTorrent from 'webtorrent';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const client = new WebTorrent();

app.use(cors({ origin: '*' }));


// OR more securely (replace with actual IP/port of your mobile)
app.use(cors({
  origin: ['http://localhost:19006', 'http://192.168.1.10:19006'], // Expo or RN dev IP
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

import auth from 'basic-auth';

const USERS = {
  admin: 'secret123', // username:password
};

function requireAuth(req, res, next) {
  const user = auth(req);
  if (!user || USERS[user.name] !== user.pass) {
    res.set('WWW-Authenticate', 'Basic realm="torrent-stream"');
    return res.status(401).send('Authentication required.');
  }
  next();
}



app.get('/search', requireAuth, async (req, res) => {
    const query = req.query.query;
    if (!query) return res.status(400).send('Query parameter is required.');

    try {
        const ytsRes = await axios.get(`https://yts.mx/api/v2/list_movies.json`, {
            params: {
                query_term: query,
                limit: 10
            }
        });

        const movies = ytsRes.data.data.movies || [];

        const results = [];

        for (const movie of movies) {
            for (const torrent of movie.torrents) {
                const magnet = buildMagnetLink(torrent.hash, movie.title);

                results.push({
                    name: `${movie.title} [${torrent.quality}]`,
                    size: torrent.size,
                    magnet,
                    thumbnail: movie.medium_cover_image
                });
            }
        }

        res.json(results);
    } catch (err) {
        console.error('🔍 Search error:', err.message);
        res.status(500).send('Failed to fetch search results.');
    }
});


app.get('/stream', (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send('Magnet link is required.');

    let infoHash;
    try {
        infoHash = extractInfoHash(magnet);
    } catch (err) {
        console.error('❌ Invalid magnet link format:', err.message);
        return res.status(400).send('Invalid magnet link.');
    }

    let torrent = client.torrents.find(t => t.infoHash === infoHash);

    if (torrent && typeof torrent.once === 'function') {
        console.log('🔁 Reusing existing torrent');
        return streamWhenReady(torrent, req, res);
    }

    console.log('📥 Adding new torrent');
    try {
        client.add(magnet, { path: './downloads' }, newTorrent => {
            streamWhenReady(newTorrent, req, res);
        });
    } catch (err) {
        console.error('❌ Failed to add torrent:', err.message);
        res.status(500).send('Could not add torrent.');
    }
});



function streamWhenReady(torrent, req, res) {
  if (torrent.ready) return checkHealthAndStream(torrent, req, res);

  torrent.once('ready', () => {
    console.log('✅ Torrent ready');
    torrent.files.forEach(f => console.log('📄', f.name));
    checkHealthAndStream(torrent, req, res);
  });

  torrent.once('error', err => {
    console.error('❌ Torrent error:', err);
    res.status(500).send('Torrent failed to load.');
  });
}

function checkHealthAndStream(torrent, req, res) {
  const mp4File = torrent.files.find(f => f.name.endsWith('.mp4'));
  if (!mp4File) {
    return res.status(404).send('No MP4 file found in torrent.');
  }

  const connectedPeers = torrent.numPeers;
  const fileLength = mp4File.length;

  console.log(`🌐 Peers connected: ${connectedPeers}`);
  console.log(`📦 File size: ${fileLength} bytes`);

  if (connectedPeers === 0 || fileLength === 0) {
    return res.status(503).send('Torrent is not healthy. Try again later.');
  }

  stream(torrent, req, res);
}



function extractInfoHash(magnetURI) {
    const match = magnetURI.match(/urn:btih:([a-fA-F0-9]+)/i);
    if (!match) throw new Error('Invalid magnet URI');
    return match[1].toLowerCase();
}



function stream(torrent, req, res) {
    const file = torrent.files.find(f => f.name.endsWith('.mp4'));
    if (!file) {
        return res.status(404).send('No MP4 file found in torrent.');
    }

    const total = file.length;
    const range = req.headers.range;

    if (!range) {
        console.warn('⚠️ Missing Range header — sending full file');

        res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': 'video/mp4',
        });

        const fullStream = file.createReadStream();
        fullStream.on('error', (err) => {
            console.error('🔥 Stream error:', err.message);
            res.status(500).end('Stream error.');
        });
        return fullStream.pipe(res);
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunksize = (end - start) + 1;

    console.log(`📼 Streaming bytes ${start}-${end} (${chunksize} bytes)`);

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
    });

    const stream = file.createReadStream({ start, end });

    stream.on('error', (err) => {
        console.error('🔥 Stream error:', err.message);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Stream error.');
        }
    });

    stream.pipe(res);
}

function buildMagnetLink(hash, name) {
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
}



const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

