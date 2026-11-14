# Wandelplanner België

Web-app voor iPhone om wandelingen in België te plannen. Geen account, geen build-stap: het is een map met statische bestanden.

## Op je iPhone zetten

1. Zet deze map op een webadres met **https** (nodig voor gps), bijvoorbeeld door de map te slepen naar Netlify Drop of via GitHub Pages of Cloudflare Pages.
2. Open het adres in **Safari** op je iPhone.
3. Tik op Deel > **Zet op beginscherm**. De app opent daarna schermvullend, zonder Safari-balken.

Lokaal uitproberen op een computer:

```bash
python3 -m http.server 8000
```

## Wat de app doet

- Tik op de kaart om punten te zetten; de route volgt wandelpaden.
- Rondwandeling laten voorstellen op een gekozen afstand (2 tot 30 km).
- Afstand, wandeltijd, hoogtemeters en hoogteprofiel.
- Kaartlagen: OpenStreetMap, topografische kaart van het NGI, reliëfkaart, plus bewegwijzerde routes en GR-paden.
- Zoeken op plaatsnaam, je eigen locatie volgen.
- Wandelingen bewaren op het toestel en als GPX delen.
- Bekeken kaartstukken en bewaarde wandelingen blijven zonder internet beschikbaar.

## Externe diensten

Gratis publieke diensten, bedoeld voor persoonlijk gebruik: kaarttegels van OpenStreetMap, NGI, OpenTopoMap en Waymarked Trails; routes via BRouter (reserve: OSRM van FOSSGIS); zoeken via Nominatim. Voor een app met veel gebruikers heb je eigen of betaalde diensten nodig.
