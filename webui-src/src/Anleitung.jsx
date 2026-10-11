import React from 'react';

/**
 * Umfangreiche Bedienanleitung. Bewusst einschpaltig gehalten:
 * Das Inhaltsverzeichnis sitzt als fließende Linkliste am Anfang
 * und funktioniert damit auf Desktop und Smartphone gleich gut.
 */

const TOC = [
  ['ueberblick', '1. So funktioniert die Bridge'],
  ['voraussetzungen', '2. Voraussetzungen'],
  ['einrichtung', '3. Ersteinrichtung in fünf Schritten'],
  ['anzeigen', '4. Statusanzeigen verstehen'],
  ['geraeteleben', '5. Wie Geräte in die HCU kommen'],
  ['typen', '6. Gerätetypen und Funktionen'],
  ['einstellungen', '7. Einstellungen im Detail'],
  ['betrieb', '8. Betrieb und Automatisierung'],
  ['pin', '9. PIN und Sicherheitshinweise'],
  ['probleme', '10. Häufige Probleme und Lösungen'],
  ['grenzen', '11. Hinweise und Grenzen'],
];

function Section({ id, title, children }) {
  return (
    <section className="card anl-section" id={`anl-${id}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Anleitung() {
  return (
    <div className="guide">
      <div className="card anl-toc">
        <h2>Inhalt</h2>
        <ol className="toc">
          {TOC.map(([id, label]) => (
            <li key={id}><a href={`#anl-${id}`}>{label}</a></li>
          ))}
        </ol>
      </div>

      <Section id="ueberblick" title="1. So funktioniert die Bridge">
        <p>
          Dieses Plugin ist eine Brücke zwischen zwei Welten: der <strong>Bosch Smart Home
          Zentrale</strong> (SHC) und Ihrem <strong>Homematic IP System</strong> mit der
          Home Control Unit (HCU). Bosch-Geräte erscheinen danach in der Homematic App und
          in HCUweb ganz normale Geräte sind - sie können geschaltet, in Automationen und
          in Gruppen verwendet werden, als wären sie native Homematic-Geräte.
        </p>
        <p>Die Brücke besteht aus zwei unabhängigen Verbindungen:</p>
        <ul>
          <li>
            <strong>Zur Bosch-Seite:</strong> eine verschlüsselte lokale Verbindung direkt zum
            Controller (SHC). Das Plugin meldet sich dort als eigener Client an - wie eine
            weitere App, nur dass sie keine Bedienung durch Menschen braucht. Diese Verbindung
            liefert alle Bosch-Gerätestände und nimmt Steuerbefehle entgegen.
          </li>
          <li>
            <strong>Zur Homematic-Seite:</strong> eine Verbindung zur HCU über die offizielle
            Connect-API. Das Plugin bietet dort seine Geräte an, meldet Zustandsänderungen und
            führt Steuerbefehle aus, die von der Homematic App, von Automationsregeln oder vom
            Wandtaster kommen.
          </li>
        </ul>
        <p>
          Beide Verbindungen arbeiten unabhängig voneinander. Ist eine gestört, bleibt die
          andere bestehen - zum Beispiel können Sie die Bosch-Zentrale neu koppeln, ohne dass
          die Homematic-Verbindung neu aufgebaut werden muss, und umgekehrt.
        </p>
        <p className="hint">
          Es wird keine Cloud benötigt. Der gesamte Datenaustausch läuft im lokalen Netzwerk.
        </p>
      </Section>

      <Section id="voraussetzungen" title="2. Voraussetzungen">
        <ul>
          <li>Eine HCU mit aktiver Plugin-Unterstützung (HCUweb öffnet die Plugin-Seite).</li>
          <li>Eine Bosch Smart Home Zentrale (SHC), Firmware aktuell gehalten.</li>
          <li>Beide Systeme im selben Netzwerk und per IP oder Name erreichbar.</li>
          <li>Für die Bosch-Seite: die Bosch Companion App, um die Pairing-PIN anzuzeigen.</li>
        </ul>
        <p className="hint">
          Prüfen können Sie die Erreichbarkeit einfach, indem Sie die IP-Adresse des
          Bosch-Controllers im Browser aufrufen - eine Zertifikatswarnung ist normal und
          bestätigt lediglich, dass die Zentrale antwortet.
        </p>
      </Section>

      <Section id="einrichtung" title="3. Ersteinrichtung in fünf Schritten">
        <ol className="steps">
          <li>
            <strong>Plugin in HCUweb installieren.</strong> Nach der Installation öffnet die
            Plugin-Konfigurationsseite in HCUweb die Verbindung zur HCU automatisch. Von dort
            führt ein Link direkt in diese WebUI.
          </li>
          <li>
            <strong>Bosch-Pairing-PIN bereitlegen.</strong> In der Bosch Companion App unter
            <em> Einstellungen - Systemsteuerung - Systemdaten - Pairing-PIN</em>. Die PIN ist
            zeitlich begrenzt gültig, also erst im nächsten Schritt ablesen.
          </li>
          <li>
            <strong>Koppeln.</strong> Auf dem Reiter <em>Dashboard</em> steht die Karte
            „Bosch Smart Home Zentrale". Dort die IP-Adresse (oder den Namen) des Controllers
            und die PIN eintragen und auf <em>Koppeln</em> klicken. Danach innerhalb des
            angezeigten Zeitfensters die <strong>Pairing-Taste am Controller</strong> drücken.
          </li>
          <li>
            <strong>Geräte in der Homematic Inbox annehmen.</strong> Nach erfolgreichem Koppeln
            verbindet sich das Plugin kurz neu und bietet alle Bosch-Geräte an. In HCUweb
            erscheinen sie in HCUweb wie neu angelernte Geräte - mit Namen, Raum und
            Gerätetyp. Die HCU übernimmt Plugin-Geräte in der Regel automatisch; ein manuelles
            Anlernen ist nicht nötig.
          </li>
          <li>
            <strong>Funktion testen.</strong> Ein schaltbares Gerät (z. B. eine Steckdose)
            einmal über die Homematic App schalten. Reagiert das Bosch-Gerät, ist die Brücke
            vollständig einsatzbereit.
          </li>
        </ol>
        <p className="hint">
          Der Kopplungsvorgang erzeugt auf Bosch-Seite einen Client mit der Kennung
          <code> oss_hcu-bosch-bridge</code>. Er ist an diese Installation gebunden und kann
          über „Entkoppeln" jederzeit wieder entfernt werden.
        </p>
      </Section>

      <Section id="anzeigen" title="4. Statusanzeigen verstehen">
        <p>Der Kopfbereich zeigt dauerhaft den Zustand beider Systeme:</p>
        <dl className="anl-defs">
          <dt>HCU</dt>
          <dd>
            Verbunden mit der Home Control Unit. Getrennt heißt: Plugin läuft, aber die HCU
            antwortet nicht (Neustart, Netzwerk). Meist erholt sich die Verbindung von selbst.
          </dd>
          <dt>BOSCH</dt>
          <dd>
            Live-Verbindung zum Bosch-Controller. Getrennt heißt: Grundzusage fehlt oder
            Zentrale war nicht erreichbar. Das Plugin versucht es automatisch erneut.
          </dd>
          <dt>Gepairt / Nicht gepairt</dt>
          <dd>
            Ob die dauerhafte Zulassung (der Client) auf dem Bosch-Controller existiert.
            „Nicht gepairt" ist der Ausgangszustand vor dem ersten Koppeln oder nach dem
            Entkoppeln.
          </dd>
          <dt>x von y eingebunden</dt>
          <dd>
            Wie viele der angebotenen Geräte die HCU tatsächlich übernommen hat.
            Solange noch Geräte in der Inbox warten, ist diese Zahl kleiner als y.
          </dd>
        </dl>
        <p className="hint">
          Die kleine Ziffer in eckigen Klammern neben jedem Eintrag zeigt denselben Wert auch
          ohne Tooltip.
        </p>
      </Section>

      <Section id="geraeteleben" title="5. Wie Geräte in die HCU kommen - und wieder hinaus">
        <p>Ein Bosch-Gerät durchläuft vier Zustände:</p>
        <ol className="steps">
          <li>
            <strong>Bekannt:</strong> Das Plugin hat das Gerät vom Bosch-Controller gelesen.
          </li>
          <li>
            <strong>Angeboten:</strong> Das Gerät wurde der HCU gemeldet und liegt dort in der
            Inbox.
          </li>
          <li>
            <strong>Eingebunden:</strong> Die HCU hat das Gerät übernommen. Ab jetzt erscheinen
            Statuswerte in der Homematic App, und Steuerbefehle funktionieren.
          </li>
          <li>
            <strong>Geparkt:</strong> Ein eingebundenes Gerät, das Sie im Reiter
            <em> HCU-Zuordnung</em> deaktiviert haben. In der HCU bleibt es erhalten, gilt aber
            als „nicht erreichbar" undreagiert nicht mehr. Einparken schützt vor Duplikaten,
            wenn dasselbe Gerät später wieder aktiviert wird.
          </li>
        </ol>
        <p><strong>Neue Bosch-Geräte:</strong> Werden sie in der Bosch App angelernt, erkennt
          das Plugin sie beim nächsten Inventarabgleich von selbst. Dafür baut es die
          HCU-Verbindung kurz neu auf - die bereits bekannten Geräte bleiben dabei unverändert
          erhalten.</p>
        <p><strong>Einzelnes Gerät entfernen:</strong> In HCUweb bei den Geräten löschen. Das
          Plugin bemerkt die Löschung, vergisst die Zuordnung und bietet das Gerät beim nächsten
          Inventarabgleich wieder an, falls es auf Bosch-Seite noch existiert. Wollen Sie es
          dauerhaft nicht in der Homematic Welt sehen, deaktivieren (parken) Sie es stattdessen
          im Reiter <em>HCU-Zuordnung</em>.</p>
        <p><strong>Alles zurücksetzen:</strong> <em>Entkoppeln</em> auf dem Dashboard entfernt
          den Bosch-Client und parkt automatisch alle Geräte. Beim nächsten Koppeln werden die
          Geräte automatisch wieder aktiviert. Die HCU-Geräte selbst bleiben bis auf weiteres
          „nicht erreichbar" und können in HCUweb gelöscht werden, wenn Sie ganz neu
          anfangen wollen.</p>
      </Section>

      <Section id="typen" title="6. Gerätetypen und Funktionen">
        <p>
          Bosch-Geräte werden nicht 1:1 kopiert, sondern auf den passenden Homematic
          Gerätetyp abgebildet. Entscheidend sind die Bosch-Dienste des Geräts:
        </p>
        <table className="anl-table">
          <thead>
            <tr><th>Bosch-Gerät (Beispiele)</th><th>Homematic-Typ</th><th>Bedienung in der Homematic Welt</th></tr>
          </thead>
          <tbody>
            <tr><td>Steckdose, Zwischenstecker</td><td>Schaltaktor</td><td>An/Aus, Zustand wird gemeldet</td></tr>
            <tr><td>Lampe, Dimmer</td><td>Dimmer</td><td>An/Aus plus Helligkeit in Prozent</td></tr>
            <tr><td>Rollladen, Jalousie</td><td>Jalousie</td><td>Position, Hoch/Runter/Stop, Fahrzeit</td></tr>
            <tr><td>Heizkörperthermostat</td><td>Heizkörper-Thermostat</td><td>Solltemperatur, Ist-Temperatur, Boost</td></tr>
            <tr><td>Fenster-, Türkontakt</td><td>Fenster-Kontakt</td><td>Offen/Geschlossen, Störung</td></tr>
            <tr><td>Bewegungsmelder</td><td>Bewegungsmelder</td><td>Kurzzeit-Impuls bei Bewegung</td></tr>
            <tr><td>Wassermelder</td><td>Wassermelder</td><td>Alarm bei Wasserkontakt</td></tr>
            <tr><td>Smoke Detector</td><td>Rauchmelder</td><td>Alarm, Selbsttest</td></tr>
            <tr><td>Wandtaster</td><td>Wandtaster bzw. Impulsschalter</td><td>Löst Automationsregeln aus</td></tr>
          </tbody>
        </table>
        <p>Darüber hinaus erscheinen virtuelle Geräte:</p>
        <ul>
          <li>
            <strong>Szene: Name</strong> - jede Bosch-Szene wird zu einem schaltbaren Gerät.
            „Ein" löst die Szene auf Bosch-Seite aus; der Schalter springt danach automatisch
            zurück.
          </li>
          <li>
            <strong>Alarmanlage (Bosch)</strong> - ein Schalter: Ein scharft die Bosch-Anlage
            scharf, Aus entschärft sie.
          </li>
          <li>
            <strong>Energiezähler</strong> und <strong>Helligkeitssensor</strong> - Zusatzgeräte
            für Messwerte, siehe Punkt 7.
          </li>
        </ul>
      </Section>

      <Section id="einstellungen" title="7. Einstellungen im Detail">
        <p>
          Alle Einstellungen wirken sofort, nichts muss gespeichert werden. Änderungen am
          Geräteangebot wirken sich auf die Gerätevielfalt in der HCU aus - Geräte verschwinden
          nicht einfach, sondern werden geparkt (siehe Punkt 5).
        </p>
        <dl className="anl-defs">
          <dt>Bosch-Szenen anbieten</dt>
          <dd>
            Jede Bosch-Szene wird als schaltbares HCU-Gerät angeboten. Praktisch, um Bosch-
            Szenen aus Homematic-Automationen auszulösen oder per Wandtaster aufzurufen.
            Wer Szenen nur in der Bosch App pflegt, kann das deaktivieren.
          </dd>
          <dt>Alarmanlage anbieten</dt>
          <dd>
            Die Bosch-Alarmanlage wird als Schalter abgebildet. Damit lässt sich die Anlage per
            Automation scharf- und unscharfschalten, zum Beispiel abends über einen Wandtaster.
          </dd>
          <dt>PIN zum Unscharfschalten im WebUI verlangen</dt>
          <dd>
            Zusätzliche Hürde in dieser Weboberfläche nur für das Entschärfen. Über die
            Homematic App und über Automationsregeln bleibt die Anlage weiterhin ohne PIN
            bedienbar - das ist die Natur der Automatisierung. Für einen echten Schutz müsste
            die Automation selbst mit Berechtigungen abgesichert werden.
          </dd>
          <dt>Energie-Zweitgeräte anbieten</dt>
          <dd>
            Steckdosen mit Leistungsmessung bekommen einen zweiten, reinen Messwert-Kanal als
            eigenes Gerät. Sinnvoll, wenn Energiezähler in einer separaten Homematic-Gruppe
            oder in der Energieauswertung geführt werden sollen.
          </dd>
          <dt>Helligkeits-Zweitgeräte</dt>
          <dd>
            Bewegungsmelder mit Helligkeitssensor erhalten ein zusätzliches Klima-Sensor-Gerät
            nur für den Lux-Wert. Nützlich, wenn die Helligkeit unabhängig von der Bewegung
            ausgewertet werden soll.
          </dd>
          <dt>Twinguard-Luftgüte</dt>
          <dd>
            Der Twinguard wird zusätzlich als Klima-Sensor angeboten, um Luftgüte und
            Luftfeuchte als separate Messwerte verfügbar zu haben.
          </dd>
          <dt>Wandtaster als Impulsschalter</dt>
          <dd>
            Sicherheits-Option: Falls ein Wandtaster als Taster-Gerät auf der jeweiligen HCU-
            Version nicht sauber unterstützt wird, schaltet das Plugin auf einen einfachen
            Impulsschalter um. Dann zuerst diese Option testen, bevor Sie das Gerät tauschen.
          </dd>
          <dt>Bewegungsimpuls (Sekunden)</dt>
          <dd>
            Bewegungsmelder sind keine Dauerzustände, sondern Ereignisse. Dieser Wert legt fest,
            wie lange der Homematic-Kanal „Bewegung" nach einem Ereignis aktiv bleibt. 10
            Sekunden passen für die meisten Automationen; kürzer für reaktive Beleuchtung,
            länger für Anwesenheitssimulationen.
          </dd>
        </dl>
      </Section>

      <Section id="betrieb" title="8. Betrieb und Automatisierung">
        <p>
          Sind die Geräte eingebunden, verhalten sie sich wie native Homematic-Geräte. Sie
          können sie benennen, verschieben, gruppieren und in Automationsregeln verwenden:
        </p>
        <ul>
          <li><strong>Schalten:</strong> Direkt aus der Homematic App, per Wandtaster oder per Automation.</li>
          <li><strong>Bedingungen:</strong> „Wenn Fenster Bad offen, dann Heizung Bad aus" - der Bosch-Fensterkontakt liefert die Daten.</li>
          <li><strong>Szenen koppeln:</strong> Eine Bosch-Szene als Aktion, oder eine Bosch-Bedingung als Auslöser einer Homematic-Automation.</li>
          <li><strong>Messen:</strong> Leistungsaufnahme und Helligkeit stehen als Zahlenwerte für Auswertungen bereit.</li>
        </ul>
        <p>
          Rückmeldungen laufen immer in beide Richtungen: Schalten Sie ein Bosch-Gerät in der
          Bosch App, aktualisiert sich der Zustand in der Homematic App innerhalb von Sekunden -
          und umgekehrt.
        </p>
      </Section>

      <Section id="pin" title="9. PIN und Sicherheitshinweise">
        <ul>
          <li>
            Die WebUI-PIN ist eine zusätzliche Hürde für heikle Aktionen in dieser
            Weboberfläche. Sie wird nur lokal im Plugin gespeichert und verlässt das Gerät nie.
          </li>
          <li>
            Sie ist bewusst von der Bosch-Pairing-PIN zu unterscheiden: Die Pairing-PIN ist
            zeitlich begrenzt und dient nur dem einmaligen Koppeln; die WebUI-PIN schützt
            wiederkehrende Bedienschritte im laufenden Betrieb.
          </li>
          <li>
            Der Bosch-Client (<code>oss_...</code>) kann jederzeit über <em>Entkoppeln</em>
            entfernt werden. Zusätzlich lässt er sich in der Bosch App unter den verbundenen
            Clients kontrollieren und löschen.
          </li>
          <li>
            Die Bosch Local API ist ausdrücklich der privaten Nutzung vorbehalten. Der
            gewerbliche Einsatz erfordert eine gesonderte Freigabe durch Bosch.
          </li>
        </ul>
      </Section>

      <Section id="probleme" title="10. Häufige Probleme und Lösungen">
        <dl className="anl-defs">
          <dt>Koppeln schlägt mit „Zeit abgelaufen“ fehl</dt>
          <dd>
            Die Pairing-PIN und das Zeitfenster sind abgelaufen. Ablauf wiederholen: Neue PIN
            ablesen, Koppeln klicken, Pairing-Taste zügig drücken. Die Taste muss gedrückt
            werden, <em>nachdem</em> das Koppeln ausgelöst wurde.
          </dd>
          <dt>„Verbindung abgelehnt“ oder Zertifikatsfehler</dt>
          <dd>
            Meist hat der Bosch-Controller eine neue IP-Adresse bekommen oder die Zentrale wurde
            zurückgesetzt. Adresse im Dashboard prüfen, ggf. neu koppeln. Nach einem
            Werksreset muss der alte Client ohnehin neu gekoppelt werden.
          </dd>
          <dt>Badges HCU getrennt, Plugin läuft aber</dt>
          <dd>
            Die HCU-Verbindung baut sich automatisch alle wenigen Sekunden neu auf. Hilft das
            nach einigen Minuten nicht: Plugin in HCUweb neu starten und die Logs prüfen.
          </dd>
          <dt>Neues Bosch-Gerät taucht nicht in der Inbox auf</dt>
          <dd>
            Auf dem Dashboard „Bosch-Inventar aktualisieren“ klicken. Danach löst das Plugin
            eine kurze Neuverbindung aus; erst dabei werden neue Geräte angeboten. Der Button
            „HCU-Neuentdeckung“ erzwingt denselben Vorgang manuell.
          </dd>
          <dt>Gerät zeigt dauerhaft „nicht erreichbar“</dt>
          <dd>
            Häufigste Ursache: Das Gerät ist geparkt. Im Reiter <em>HCU-Zuordnung</em> prüfen
            und mit <em>Aktivieren</em> wieder scharf schalten. Zweite Möglichkeit: Das
            Bosch-Gerät existiert nicht mehr oder die Bosch-Verbindung steht nicht.
          </dd>
          <dt>Gerät ist doppelt in der HCU vorhanden</dt>
          <dd>
            Nicht das Plugin-Gerät löschen und neu anlernen, während die Plugin-Installation
            besteht - das kann Duplikate erzeugen. In HCUweb nur Geräte löschen, deren
            Zuordnung im Reiter <em>HCU-Zuordnung</em> als „eingebunden“ mit leerer Zwillings-Id
            oder als verwaist erkennbar sind; im Zweifel zuerst parken, dann beobachten.
          </dd>
          <dt>Steuerung aus der Homematic Appreagiert nicht</dt>
          <dd>
            Ist der BOSCH-Badge verbunden? Ist das Gerät nicht geparkt? Die Logs zeigen
            abgesetzte Befehle und Bosch-Fehlermeldungen - dort steht in den allermeisten
            Fällen die eigentliche Ursache.
          </dd>
          <dt>WebUI ist nicht erreichbar</dt>
          <dd>
            Der Link auf der Plugin-Seite in HCUweb führt immer zur aktuellen Adresse. Auf
            welchem Port die Weboberfläche läuft, steht in der Plugin-Konfiguration der HCU.
          </dd>
        </dl>
      </Section>

      <Section id="grenzen" title="11. Hinweise und Grenzen">
        <ul>
          <li>
            <strong>Kein Home Connect:</strong> Haushaltsgeräte mit Bosch Home Connect
            (Waschmaschine, Trockner usw.) sprechen eine andere Sprache und sind über die Bosch
            Smart Home Zentrale nicht direkt steuerbar. Eine Mess-Steckdose bildet trotzdem
            alles Wichtige ab: Lauf erkennen, fertig melden, standbyfrei schalten.
          </li>
          <li>
            <strong>Kein Löschen von der Plugin-Seite:</strong> Die Connect-API erlaubt es
            Plugins nicht, HCU-Geräte selbst zu löschen. Deaktivieren heißt deshalb immer
            „parken“; endgültiges Löschen passiert in HCUweb.
          </li>
          <li>
            <strong>Bosch-Funktionen bleiben erhalten:</strong> Alles, was in der Bosch App
            funktioniert, funktioniert weiterhin. Die Bridge ergänzt nur die Homematic-Welt,
            sie ersetzt keine Funktionen.
          </li>
          <li>
            <strong>Ältere HCU-Versionen:</strong>einige  Gerätevarianten (Taster, Luftgüte)
            werden nicht von jeder HCU-Firmware gleich gut unterstützt. Dafür gibt es die
            Rückfall-Optionen unter Einstellungen.
          </li>
        </ul>
      </Section>
    </div>
  );
}
