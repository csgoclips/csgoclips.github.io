const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const bz2 = require('unbzip2-stream');
const { decodeMatchShareCode } = require('csgo-sharecode');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const { parseEvent, parseTicks } = require('@laihoe/demoparser2');

const app = express();
app.use(cors());
app.use(express.json());

const user = new SteamUser();
const csgo = new GlobalOffensive(user);
let gcReady = false;

// Log into Steam bot account using Environment Variables
if (process.env.STEAM_USER && process.env.STEAM_PASS) {
    user.logOn({
        accountName: process.env.STEAM_USER,
        password: process.env.STEAM_PASS
    });
}

user.on('loggedOn', () => {
    console.log('Logged into Steam!');
    user.gamesPlayed([730]); // Launch CS2 AppID
});

csgo.on('connectedToGC', () => {
    console.log('Connected to CS2 Game Coordinator!');
    gcReady = true;
});

// Helper: Request match info from Valve GC
function getMatchData(matchId, outcomeId, token) {
    return new Promise((resolve, reject) => {
        if (!gcReady) return reject(new Error('CS2 Game Coordinator not ready yet.'));
        
        const timeout = setTimeout(() => reject(new Error('Valve GC request timed out.')), 15000);
        
        csgo.requestGame(matchId, outcomeId, token);
        csgo.once('matchList', (matches) => {
            clearTimeout(timeout);
            if (!matches || matches.length === 0) {
                return reject(new Error('Match not found or demo expired (demos expire after ~14 days).'));
            }
            resolve(matches[0]);
        });
    });
}

// Main API Endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { shareCode, steamId, fov, viewmodelFov, overlayText, videoFormat } = req.body;

        // 1. Decode Share Code
        const decoded = decodeMatchShareCode(shareCode);
        console.log('Decoded Share Code:', decoded);

        // 2. Get Demo Download URL from Valve
        const matchInfo = await getMatchData(decoded.matchId, decoded.outcomeId, decoded.token);
        const lastRound = matchInfo.roundstatsall[matchInfo.roundstatsall.length - 1];
        const demoUrl = lastRound.map; // Valve stores the .dem.bz2 URL in the last round's map field

        if (!demoUrl) {
            return res.status(404).json({ error: 'Demo download link unavailable or expired.' });
        }

        // 3. Download and decompress .dem file
        const demoPath = path.join(__dirname, `${decoded.matchId}.dem`);
        const response = await axios({ url: demoUrl, method: 'GET', responseType: 'stream' });
        
        await new Promise((resolve, reject) => {
            response.data
                .pipe(bz2())
                .pipe(fs.createWriteStream(demoPath))
                .on('finish', resolve)
                .on('error', reject);
        });

        // 4. Parse Demo for Best Highlight (Multi-kills)
        const deaths = parseEvent(demoPath, 'player_death');
        
        // Group kills by attacker and round
        const roundKills = {};
        deaths.forEach(d => {
            if (!d.attacker_steamid || d.attacker_steamid === d.user_steamid) return;
            if (steamId && d.attacker_steamid !== steamId) return;

            const key = `${d.attacker_steamid}_round_${d.total_rounds_played}`;
            if (!roundKills[key]) {
                roundKills[key] = {
                    attackerName: d.attacker_name,
                    attackerSteamId: d.attacker_steamid,
                    round: d.total_rounds_played + 1,
                    kills: []
                };
            }
            roundKills[key].kills.push(d.tick);
        });

        // Sort to find the round with the most kills
        const sortedHighlights = Object.values(roundKills).sort((a, b) => b.kills.length - a.kills.length);
        
        // Clean up demo file to save server disk space
        fs.unlinkSync(demoPath);

        if (sortedHighlights.length === 0) {
            return res.status(404).json({ error: 'No highlights found for that player in this match.' });
        }

        const best = sortedHighlights[0];
        const startTick = Math.max(0, best.kills[0] - 256); // 4 seconds before first kill (64 tick)
        const endTick = best.kills[best.kills.length - 1] + 192; // 3 seconds after last kill

        // 5. Build CS2 Console Config (.cfg) for smooth cs2.video style recording
        const cfgContent = [
            `// Auto-generated CS2 Highlight Config`,
            `// Player: ${best.attackerName} | Round ${best.round} (${best.kills.length}K)`,
            `sv_cheats 1`,
            `cl_draw_only_deathnotices 1`,
            `fov_cs_debug ${fov || 90}`,
            `viewmodel_fov ${viewmodelFov || 68}`,
            `spec_player_by_accountid ${best.attackerSteamId}`,
            `demo_gototick ${startTick}`,
            `echo "HIGHLIGHT READY: ${overlayText || best.attackerName + ' ' + best.kills.length + 'K'}"`
        ].join('\n');

        res.json({
            success: true,
            demoUrl,
            highlight: {
                player: best.attackerName,
                round: best.round,
                killsCount: best.kills.length,
                startTick,
                endTick,
                format: videoFormat
            },
            cfgContent
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Server error analyzing match.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CS2 Highlight API running on port ${PORT}`));
