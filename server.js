const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const mercadopago = require('mercadopago');
const fetch = require('node-fetch'); // node-fetch@2
const ffmpeg = require('fluent-ffmpeg');
const { tmpdir } = require('os');
const path = require('path');

// ==========================
// WhatsApp Bot
// ==========================
const client = new Client({ authStrategy: new LocalAuth() });
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('🤖 Bot pronto!'));
client.initialize();

// ==========================
// Mercado Pago (versão 1.5.x)
// ==========================
mercadopago.configure({
  access_token: 'APP_USR-2716966108349888-081713-105159561c6b69df37057de054ab4f86-128577498'
});

// ==========================
// Gemini TTS - Enceladus
// ==========================
let apiKeys = fs.readFileSync('keys.txt', 'utf-8').split('\n').filter(k => k.trim());
let currentKeyIndex = 0;
function getApiKey() { return apiKeys[currentKeyIndex % apiKeys.length].trim(); }

async function generateTTS(text) {
    const styledText = `Read aloud in the style of a Brazilian "carro de som" street announcement: energetic, lively, highly engaging, and attention-grabbing. Use a cheerful and enthusiastic tone with dynamic intonation, exaggerated emphasis on key words, and rhythmic pacing that mimics promotional loudspeakers. The delivery should sound festive, persuasive, and impossible to ignore, as if attracting a crowd in a busy street or neighborhood.\n\n${text}`;

    while (currentKeyIndex < apiKeys.length) {
        try {
            const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateSpeech", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": getApiKey(),
                },
                body: JSON.stringify({
                    input: styledText,
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Enceladus" } }
                }),
            });
            if (!resp.ok) throw new Error("Quota error");
            const result = await resp.json();
            const audioBase64 = result.audio?.[0]?.data;
            return Buffer.from(audioBase64, 'base64');
        } catch (e) {
            console.warn("Chave esgotada, tentando próxima...");
            currentKeyIndex++;
        }
    }
    throw new Error("Todas as chaves da API esgotadas");
}

// ==========================
// Mixagem de áudio com música de fundo
// ==========================
async function mixAudio(voiceBuffer, musicBuffer, volume = 0.1) {
    const voiceFile = path.join(tmpdir(), `voice_${Date.now()}.ogg`);
    const musicFile = path.join(tmpdir(), `music_${Date.now()}.mp3`);
    const outputFile = path.join(tmpdir(), `mixed_${Date.now()}.ogg`);

    fs.writeFileSync(voiceFile, voiceBuffer);
    fs.writeFileSync(musicFile, musicBuffer);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(voiceFile)
            .input(musicFile)
            .complexFilter([
                `[1:a]volume=${volume},apad[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0,volume=1`
            ])
            .output(outputFile)
            .on('end', () => {
                const data = fs.readFileSync(outputFile);
                fs.unlinkSync(voiceFile);
                fs.unlinkSync(musicFile);
                fs.unlinkSync(outputFile);
                resolve(data);
            })
            .on('error', reject)
            .run();
    });
}

// ==========================
// Criação de cobrança PIX
// ==========================
async function criarPix(userNumber, text) {
    const pagamento = await mercadopago.payment.create({
        transaction_amount: 0.25,
        description: "Locução estilo carro de som (Enceladus)",
        payment_method_id: "pix",
        payer: { email: "comprador@exemplo.com" },
        metadata: { userNumber, text }
    });
    return pagamento.body.point_of_interaction.transaction_data;
}

// ==========================
// Armazena pedidos dos usuários
// ==========================
const userRequests = {}; // { userNumber: { text, type, music, musicVolume } }

// ==========================
// Listener WhatsApp
// ==========================
client.on('message', async msg => {
    const body = msg.body?.trim() || '';
    const user = msg.from;

    // Mensagem de texto !tts ou !ttsbg
    if (body.startsWith("!tts") || body.startsWith("!ttsbg")) {
        const texto = body.replace(/!tts(bg)?/, "")
                  .trim()
                  .replace(/\n+/g, ". ");
        const tipo = body.startsWith("!ttsbg") ? "bg" : "normal";
        userRequests[user] = { text: texto, type: tipo, music: null, musicVolume: 0.1 };

        const pix = await criarPix(user, texto);
        msg.reply(
            `💵 Para receber sua locução, pague R$5,00 via PIX:\n` +
            `**Código Copia e Cola:**\n${pix.qr_code}\n` +
            `**QR Code:**\n${pix.qr_code_base64}\n` +
            `Se quiser música de fundo, envie o arquivo de áudio antes do pagamento.`
        );
        return;
    }

    // Recebe música de fundo enviada pelo usuário
    if (msg.hasMedia && userRequests[user]?.type === "bg") {
        const media = await msg.downloadMedia();
        const audioBuffer = Buffer.from(media.data, 'base64');
        userRequests[user].music = audioBuffer;
        msg.reply("🎵 Música de fundo recebida com sucesso! Ela será usada na locução.");
        return;
    }

    // Comando de volume: !vol X
    if (body.startsWith('!vol')) {
        const [, volStr] = body.split(' ');
        let vol = parseInt(volStr);
        if (isNaN(vol) || vol < 0 || vol > 100) {
            return msg.reply('⚠️ Informe um valor de volume entre 0 e 100. Ex: !vol 30');
        }
        if (!userRequests[user]?.music) {
            return msg.reply('⚠️ Você precisa enviar uma música primeiro com !ttsbg.');
        }
        userRequests[user].musicVolume = vol / 100;
        return msg.reply(`🔊 Volume da música ajustado para ${vol}%`);
    }

    // Refazer locução
    if (body === "!refazer" && userRequests[user]) {
        const { text, type, music, musicVolume } = userRequests[user];
        let audio = await generateTTS(text);
        if (type === "bg" && music) audio = await mixAudio(audio, music, musicVolume);
        const media = new MessageMedia("audio/ogg; codecs=opus", audio.toString("base64"));
        await client.sendMessage(user, media, { sendAudioAsVoice: true });
        msg.reply("🔁 Locução refeita com sucesso!");
        return;
    }
});

// ==========================
// Webhook Mercado Pago
// ==========================
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data.type === "payment" && data.data?.id) {
            const pagamento = await mercadopago.payment.findById(data.data.id);
            if (pagamento.body.status === "approved") {
                const { userNumber, text } = pagamento.body.metadata;
                const reqInfo = userRequests[userNumber];
                if (!reqInfo) return res.sendStatus(200);

                let audio = await generateTTS(text);
                if (reqInfo.type === "bg" && reqInfo.music) {
                    audio = await mixAudio(audio, reqInfo.music, reqInfo.musicVolume);
                }

                const media = new MessageMedia("audio/ogg; codecs=opus", audio.toString("base64"));
                await client.sendMessage(userNumber, media, { sendAudioAsVoice: true });
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.sendStatus(500);
    }
});

app.listen(3000, () => console.log("🌐 Webhook rodando na porta 3000"));
