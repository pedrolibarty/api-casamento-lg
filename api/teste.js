import { ImapFlow } from "imapflow";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Método não permitido" });
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.PIX_EMAIL,
      pass: process.env.PIX_PASSWORD,
    },
  });

  await client.connect();

  let emails = [];
  let lock = await client.getMailboxLock("INBOX");

  const uidsToMarkAsSeen = [];

  try {
    for await (let msg of client.fetch(
      { from: "no-reply@picpay.com", seen: false },
      { envelope: true, source: true }
    )) {
      const assunto = msg.envelope.subject || "";

      if (assunto.trim() === "Pagamento recebido via Pix") {
        const raw = msg.source.toString();

        const bodyMatch = raw.match(
          /Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/i
        );
        const body = bodyMatch
          ? bodyMatch[1].trim()
          : "(Não foi possível extrair texto)";

        emails.push({
          assunto,
          de: msg.envelope.from[0].address,
          corpo: body,
        });

        uidsToMarkAsSeen.push(msg.uid);
      }
    }

    if (uidsToMarkAsSeen.length > 0) {
      await client.messageFlagsAdd(uidsToMarkAsSeen, ["\\Seen"]);
    }
  } finally {
    lock.release();
  }

  await client.logout();

  const newPayments = [];

  for (let i = 0; i < emails.length; i++) {
    const content = emails[i].corpo;

    const iniName = "Pix=20de=0A";
    const endName = "=0AValor=20";

    const posIniName = content.indexOf(iniName);
    if (posIniName === -1) continue;

    const posEndName = content.indexOf(endName, posIniName + iniName.length);
    if (posEndName === -1) continue;

    let namePix = content
      .substring(posIniName + iniName.length, posEndName)
      .trim();

    namePix = namePix.replace(/=20/g, " ");

    namePix = namePix
      .toLowerCase()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const iniValue = "0AR$=20";

    const posIniValue = content.indexOf(iniValue);
    if (posIniValue === -1) continue;

    const valueSubstr = content.substring(posIniValue + iniValue.length);
    const posVirgula = valueSubstr.indexOf(",");
    if (posVirgula === -1) continue;

    let valuePix = valueSubstr.substring(0, posVirgula + 3);

    valuePix = Number(valuePix.replace(",", "."));

    newPayments.push({
      namePix: namePix,
      value: valuePix,
      status: "P",
    });
  }

  return res.status(200).json({ newPayments });
}
