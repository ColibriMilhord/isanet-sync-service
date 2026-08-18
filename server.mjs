// server.mjs
// Service HTTP (Render Web Service) exposant POST /sync/isanet-clients
// Playwright fait la connexion + export CSV, logs renvoyés en JSON.
//
// Env vars (Render) :
//   ISANET_EMAIL, ISANET_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SYNC_SECRET            -> secret partagé pour protéger l'endpoint (voir note sécurité en bas)
//
// Dépendances : express, playwright, @supabase/supabase-js, csv-parse

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import fs from "node:fs/promises";
import WebSocket from "ws";

// Polyfill global requis par @supabase/supabase-js (module realtime) sur
// Node < 22, qui n'a pas WebSocket natif. Doit être fait AVANT createClient.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket;
}

const app = express();
app.use(cors()); // Autorise les appels cross-origin depuis le frontend Render
app.use(express.json());

const LOGIN_URL = "https://app.isanet-fact.fr/login";
const CONTACTS_URL = "https://app.isanet-fact.fr/contacts";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/sync/isanet-clients", async (req, res) => {
  // --- Sécurité minimale : secret partagé dans le header ---
  if (req.headers["x-sync-secret"] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Non autorisé" });
  }

  const dryRun = req.body?.dryRun !== false; // dry-run par défaut, sécurité
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push({ t: new Date().toISOString(), msg });
  };

  let browser;
  try {
    log("Lancement du navigateur headless...");
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "fr-FR",
    });
    // Masque les signaux les plus communs de détection d'automatisation.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    log("Navigation vers la page de connexion IsanetFact...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });

    await page.fill('input[type="email"]', process.env.ISANET_EMAIL);
    // Le champ email a un debounce Livewire de 500ms (wire:model.debounce.500ms) :
    // il faut laisser le temps à l'AJAX interne d'enregistrer la valeur côté
    // serveur avant de soumettre, sinon le formulaire part avec un champ vide.
    await page.waitForTimeout(900);

    await page.fill(
      'input[autocomplete="current-password"]',
      process.env.ISANET_PASSWORD
    );
    await page.waitForTimeout(300);

    log("Identifiants saisis, soumission du formulaire...");
    await page.click('button[type="submit"]');
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    if (page.url().includes("/login")) {
      // Tente de récupérer un message d'erreur visible (inline OU toast toastr).
      let visibleError = "";
      try {
        const errorLocator = page
          .locator(
            '[role="alert"], .alert, .error, .text-red-500, .text-danger, .toast-message, .toast-error, #toast-container, .toastify, .swal2-html-container'
          )
          .first();
        if (await errorLocator.count()) {
          visibleError = (await errorLocator.innerText()).trim();
        }
      } catch {
        // ignore
      }

      // Filet de sécurité : cherche des mots-clés d'erreur dans tout le texte visible.
      if (!visibleError) {
        try {
          const bodyText = await page.locator("body").innerText();
          const keywords = ["incorrect", "invalide", "erreur", "échoué", "captcha", "bloqué", "suspect", "robot", "sécurité"];
          const lower = bodyText.toLowerCase();
          for (const kw of keywords) {
            const idx = lower.indexOf(kw);
            if (idx !== -1) {
              visibleError = bodyText.slice(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, " ").trim();
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      throw new Error(
        `Toujours sur /login après connexion.${
          visibleError ? ` Message/texte détecté: "${visibleError}"` : " Aucun message d'erreur ni mot-clé détecté sur la page."
        }`
      );
    }
    log("Connexion réussie.");

    log("Navigation vers Mes contacts...");
    await page.goto(CONTACTS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("input.table-checkbox", { timeout: 20000 });
    await page.waitForTimeout(500);

    log("Sélection de tous les contacts...");
    const headerCheckbox = page.locator("input.table-checkbox").first();
    if (await headerCheckbox.count()) {
      await headerCheckbox.check();
      await page.waitForTimeout(500); // laisse le x-on:change Alpine.js peupler selectedRows
    } else {
      const rowCheckboxes = page.locator("[data-listing-checkbox]");
      const count = await rowCheckboxes.count();
      log(`Pas de case "tout sélectionner", sélection ligne par ligne (${count} lignes).`);
      let checkedCount = 0;
      let skippedCount = 0;
      for (let i = 0; i < count; i++) {
        try {
          await rowCheckboxes.nth(i).check({ timeout: 5000 });
          checkedCount++;
        } catch {
          skippedCount++;
        }
      }
      log(`${checkedCount} case(s) cochée(s), ${skippedCount} ignorée(s) (non cochables).`);
      if (checkedCount === 0) {
        throw new Error("Aucune case à cocher n'a pu être sélectionnée — sélecteur probablement inadapté à la structure réelle du tableau.");
      }
    }

    log("Ouverture du menu d'actions groupées (icône éclair)...");
    const boltMenuTrigger = page
      .locator('[class*="bolt"], [class*="lightning"], button:has(i[class*="bolt"])')
      .first();
    if (!(await boltMenuTrigger.count())) {
      throw new Error("Icône éclair introuvable — sélecteur à ajuster.");
    }
    await boltMenuTrigger.click();

    // L'export ne télécharge pas directement : il lance une tâche asynchrone
    // dont le résultat apparaît dans le centre de notifications (cloche), avec
    // un lien /file/{id}/download une fois prêt (peut prendre du temps pour
    // de gros volumes).
    log('Clic sur "Exporter" > "CSV (.csv)"...');
    await page.getByText("Exporter", { exact: true }).click();
    const csvMenuItem = page.locator("div.menu-link", { hasText: "CSV" }).first();
    await csvMenuItem.click();

    log("Export lancé. Ouverture du centre de notifications...");
    await page.locator("#panel_notification_center").click();
    await page.waitForTimeout(1000);

    log("Attente que l'export soit prêt (peut prendre 1-2 minutes pour un gros volume)...");
    const downloadLink = page.locator('#panel-notification-body a[href*="/file/"]').first();
    const maxWaitMs = 150000;
    const pollIntervalMs = 4000;
    let waited = 0;
    while (waited < maxWaitMs) {
      if (await downloadLink.count()) break;
      await page.waitForTimeout(pollIntervalMs);
      waited += pollIntervalMs;
    }
    if (!(await downloadLink.count())) {
      throw new Error(
        `Export toujours pas prêt après ${maxWaitMs / 1000}s d'attente — le job côté IsanetFact prend peut-être plus de temps que prévu.`
      );
    }
    log(`Export prêt après ${Math.round(waited / 1000)}s, téléchargement...`);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }),
      downloadLink.click(),
    ]);

    const csvPath = await download.path();
    const csvContent = await fs.readFile(csvPath, "utf-8");
    log(`CSV téléchargé (${csvContent.length} caractères).`);

    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      delimiter: ";",
    });
    log(`${records.length} lignes parsées. Colonnes: ${Object.keys(records[0] || {}).join(", ")}`);

    const rows = records.map((r) => ({
      nom: r["Nom"] ?? r["NOM"] ?? null,
      email: r["Email"] ?? r["E-mail"] ?? null,
      telephone: r["Téléphone"] ?? null,
      adresse: r["Adresse de facturation"] ?? r["Adresse"] ?? null,
      isanet_reference: r["Référence"] ?? r["ID"] ?? null,
      updated_at: new Date().toISOString(),
    }));

    if (dryRun) {
      log("Mode dry-run : aucune écriture en base. Aperçu des 3 premières lignes ci-dessous.");
      return res.json({
        success: true,
        dryRun: true,
        count: rows.length,
        preview: rows.slice(0, 3),
        logs,
      });
    }

    log(`Upsert de ${rows.length} clients dans Supabase...`);
    const { error } = await supabase
      .from("clients")
      .upsert(rows, { onConflict: "isanet_reference" });
    if (error) throw error;

    log("Upsert terminé avec succès.");
    return res.json({ success: true, dryRun: false, count: rows.length, logs });
  } catch (err) {
    log(`ERREUR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message, logs });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Service isanet-sync démarré sur le port ${port}`));
