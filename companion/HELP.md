## ATEM Audio

Your ATEM's audio, run like a proper desk. Here's what's in the box:

- auto level and calibrate on each input, riding the trim or the fader
- Intech Grid (or any MIDI) faders with pickup
- Fairlight EQ (all six bands), expander / gate, compressor and limiter, with gain-reduction meters
- on / off / audio follow video, frame delay, the master, headphones and talkback
- PFL and solo on the ATEM's own solo, so the programme never hears a thing
- automatic switching to backup feeds
- the ATEM's own recording and streaming, with a planned restart
- a fader and meter page in any browser

It plays nicely with others. Run it alongside the official ATEM module and both can be connected to the same ATEM.

### Setting it up

**1. Find the ATEM's address.** Open ATEM Setup, pick the ATEM, and look under **Configure → Network**. The bigger ATEMs show it on the front panel too. This computer and the ATEM need to be on the same network.

**2. Add this connection** and pop the address in. The port is **9910** on every ATEM: leave it be unless something in between moves it.

Not sure what a field does? Hover over it and it'll tell you.

Heads up: connection fields don't take variables (Companion's rule, not mine). If one has a variable in it, such as `$(custom:atem_ip)`, I use the field's default instead and say so in the log. Want a variable to drive it? See **Driving the connection from a variable**, further down.

**3. Open the fader page.** The connection's page shows its address as a link. Or, take your pick:

- the **Open the fader page** preset
- the `$(ATEM_Audio:page_url)` variable
- `http://<this computer's address>:8891/`

It's 8891 so it can sit next to OBS Audio's 8890 without a squabble. **Fader page available on** decides who can open it: every network, this computer only, or one network. If others on the network shouldn't be fiddling, set a PIN.

#### Only so many seats at the table

An ATEM only lets a handful of things control it at once. Blackmagic have never said how many: people report about 5 on the small and older models, and about 8 on the 2 M/E and 4 M/E. This connection takes one, ATEM Software Control takes one, the official ATEM module takes one, and so on. If I can't get in, close something you're not using.

One more thing: an ATEM that's lost a connection without a goodbye can keep that seat for a while. I always say goodbye properly when a connection is switched off or changed.

#### If it won't connect

The connection's status tells you why, in plain words:

- **No ATEM address yet:** pop one in.
- **Looking for the ATEM:** give it a few seconds.
- **Can't reach the ATEM:** it's off, the address is wrong, it's on another network, or it's run out of seats (see above).
- **Lost the ATEM:** the network dropped or the ATEM restarted. I'll keep trying.
- **Connected, but no audio mixer:** a few ATEMs haven't got one I can drive.

### Fairlight or classic: what you get

ATEMs come with one of two audio mixers. I work out which when I connect, and anything an ATEM hasn't got just doesn't show up.

**Fairlight** (ATEM Minis, SDI, Television Studio HD8 and 4K8, Television Studio Pro 4K, Constellations):

- every input gets a strip: trim, fader, pan, on / off / AFV, and frame delay where the input has it (usually the analog ones, up to 8 frames)
- an input split into two mono channels (dual mono) gets two strips, **ch 1** and **ch 2**. **Input: stereo or split** does the splitting
- EQ with six bands, expander / gate, compressor with make-up gain, and limiter, all with knobs on the page and gain-reduction meters
- a pre-fader meter (after the trim, EQ and dynamics) and a post-fader one
- the **Master** strip: fader, EQ, compressor, limiter (no expander: the ATEM hasn't got one there), and follow fade to black
- **Headphones** on models with a headphone out. On the Mini Extreme, SDI Extreme ISO, HD8, 4K8 and Constellations you also get separate **programme**, **talkback** and **sidetone** levels, and mutes for programme and talkback
- mic or line level for analog inputs

**Classic** (Television Studio, TVS HD, TVS Pro HD, 1, 2 and 4 M/E, Production Studio 4K):

- gain (the fader), balance, on / off / AFV
- the master, the monitor out (level, mute, dim) and headphone levels (programme, talkback, sidetone)
- post-fader meters only. The ATEM library I use can't do classic meters, so I've taught it (see **Good to know**)
- no trim, EQ or dynamics: classic ATEMs simply haven't got them

### Talkback

The ATEM has no talk button I can press for you. What I can drive is how loud talkback is in the headphones, and its mute. They're the **Talkback** strip, and the **Headphones / talkback** actions.

### The fader page

Each input gets a strip, just like a sound desk. Left to right:

- **Fader and meters.** PRE is the level before the fader; POST is what goes to air. Compressors, limiters and expanders that are working show a GR (gain reduction) meter. Each strip has PRE / POST / FINE buttons, and the meter shows auto level's target line and band. Drag the fader; use FINE (or two fingers) for small moves; double tap for 0 dB.
- **Channel settings.** Basic auto gain sits at the top, with sections of controls underneath (Input, Processing...). Knobs work by dragging up and down: Shift for fine, double click to reset, click the value to type one.
- **Show advanced.** Opens every auto gain and backup setting over the channel settings. **Pin** keeps it open as a third column.
- **MUTE / PFL / SOLO** live at the bottom of each strip.

The master and the headphone strips are labelled, so you can't mix them up with an input.

Every page setting lives in **⚙ Settings**, a floating panel you can drag out of the way. You can reach them from Companion too, with **Fader page: change a setting**. Sections are yours to arrange: **Settings → Sections** to add, rename and reorder, **Settings → Inputs** to override per input, and order or hide inputs. **Settings → Export / import** exports the lot; on import, tick what to bring in, and the settings in use are kept as an autosave first.

#### The look

The faders have proper desk-style caps now: chunky, with a bright line across the middle and a shadow, so you can find them from across the room. In **Settings → Page** (or with **Fader page: change a setting**):

- **Fader cap colour** (`capColour`) and **Fader cap centre line** (`capLineColour`): any colour you like. Purple is the correct answer, but it's your desk.
- **Fader dB scale** (`faderScaleSide`): `left` or `right` of the fader.
- **Meter dB scale** (`meterScaleSide`): `left` or `right` of the meters. Set separately, so mix and match.
- **Faint colours behind the meters** (`meterPaleBack`, true / false) and **How faint** (`meterPaleStrength`, 0 to 1): the unlit part of each meter shows its green, yellow and red zones, faintly, so you can see where you're heading before you get there.

Odd values (a colour that isn't a colour, a side that's neither left nor right) are skipped, and the setting stays as it was.

### Joining pages: one page, every desk

Got more than one ATEM, or an OBS next to it? Any OBS Audio or ATEM Audio page can pull in strips from the others, on this computer or anywhere on the network. Press **SOURCES** in the header.

- **Found on the network:** every OBS Audio and ATEM Audio connection with its finder on turns up here within a few seconds. Tick one and its strips appear.
- **Add by address:** on another subnet or a VPN, or its finder's off? Type its page address (as in its `page_url` variable, e.g. `192.168.1.20:8891`).
- **PIN:** if a source has a PIN, you're asked once. This browser remembers it until it stops working (it changed), then asks again.
- **Colour tag:** each source gets a colour, so you know whose strip is whose. Change it with the swatch.
- **Remove:** ✕ takes a source off this page. Its own page carries on as normal.

Two ways to lay it out:

- **Grouped by source:** each source gets its own labelled block in its colour. Move blocks with ◀ ▶, fold one away with ▾.
- **Free arrangement:** any strip, from any source, anywhere. Grab the ⠿ by a strip's name and drag it. Each strip wears a little tag saying where it's from.

The layout, colours, PINs and arrangement are remembered in this browser, so a phone and the laptop can each have their own. Every control on a joined strip works that strip's own desk (it talks straight to that connection). Grid faders stay with their own connection, so the joined page doesn't move them.

**On the connection page:** **Let other pages find this one** (on unless you say otherwise) and **Page finder port** (UDP, default 48999). Every connection that should find the others needs the same port. Several connections on one computer can share it. Switch the finder off and pages can still join by address; the PIN applies either way. If nothing turns up, the network may be blocking broadcasts: add by address instead.

### Mute, on, off and AFV

On an ATEM, "mute" is the input's **off**. So:

- **Mute** turns it off. **Unmute** puts back what it was before: on, or audio follow video.
- **Input: on / off / audio follow video** sets it directly, or toggles on / off or AFV / off.
- **ATEM: audio follow video crossfades** turns the crossfade on transitions on or off for the whole mixer.

### PFL and solo

PFL and solo use the ATEM's own **solo**, so you hear them on the headphone or monitor out. The programme and the recording are left well alone. You need a model with a headphone or monitor out (the Mini, Mini Pro, Mini Pro ISO, SDI and SDI Pro ISO haven't got one, so no PFL there).

- **PFL** solos one input. The ATEM only solos one thing at a time, so PFL on another input swaps over rather than adding up.
- **SOLO** works only while held, unless **Solo latch** is ticked. When it ends, the PFL goes back to how it was.

### Backup feeds

Any input can be the backup of another, say a second radio mic on the same presenter. In the backup's strip, go to **Input → Backup for**, then turn on **Auto switch** under Show advanced → Backup feed.

If the main drops out, or goes much louder or quieter than usual against the backup, while the backup is healthy, it crossfades to the backup and a pop-up tells you why. **It never switches back by itself.** Once the main looks healthy for a while, a pop-up offers Take, Snooze, Swap roles or Dismiss. Every threshold and time is a setting.

### Recording and streaming

On ATEMs that record and stream (Mini Pro and up, with ATEM software 8.1.1 or later):

- **● REC** in the header starts the ATEM recording. Press it while recording and it asks "Stop recording?", then "Are you definitely sure?". (Belt and braces. 🎙️)
- After stopping, it asks when recording is due to restart, with an option to start automatically. A planned start shows as a countdown, and a **Start recording?** pop-up appears 10 minutes before (that's a setting) if it isn't automatic.
- **Recording: set the file name** sets what the ATEM calls the next take (up to 128 bytes; the ATEM adds its own number). Set it before you start.
- **Recording: ISO**, **switch disk**, and **Streaming: start / stop** do what they say. Variables show the disk, time left, any problem the ATEM reports (no disk, disk full...), and the stream's time and bitrate.

#### Getting at the files

The ATEM records to a USB or SSD drive plugged into it, so I can only see the files if this computer can. Put that folder in **Where the recordings can be found** on the connection page:

- **A drive or shared folder** this computer can read: just put its path in.
- **ATEM Mini Pro, Pro ISO and Extreme** have an FTP server for the drive (people say it works even while recording; I haven't tried it yet). I can't read FTP myself yet, so connect to it as a drive on this computer first (Mac Finder: **Go → Connect to Server**, `ftp://<ATEM address>`; Windows: **Map network drive**) and put that folder in. Heads up: the Mac mounts FTP read-only.

If I can't read the folder, I say why on the connection's log and in `$(ATEM_Audio:rec_folder_problem)`, and the file count is left blank.

### Recordings: names from a spreadsheet, a file manager and uploads

**Settings → Recordings** is where your recordings live. It works with any joined source too: pick it from **Source** at the top.

**Files.** Every recording in the folder from **Where the recordings can be found**, newest first, with its size and length. Each one has:

- **▶ PLAY:** a look (or a listen) right there in the browser. MP4 and MOV play pretty much everywhere; MKV in Chrome; FLV and TS not at all, so download those.
- **⤓:** download a copy.
- **RENAME:** a new name. It keeps its real ending, so typing `final.mov` on an MP4 gives `final.mov.mp4` (it still plays).
- **UPLOAD:** send this one now, whatever the upload timing says.
- **✕:** delete. It asks "Are you sure?" first, and there's no bin, so mean it.

The file being recorded can't be renamed or deleted until it's stopped.

**Sheet source.** Where the names come from:

- **Google Sheet:** paste the link from your browser. The sheet must be shared **Anyone with the link can view** (or published to the web). Private sheets that need a Google sign-in can't be read yet: download it as CSV and drop that in instead. Edits turn up every 30 seconds (that's a setting), and **Read it now** doesn't wait.
- **CSV / Excel file:** drop a `.csv` or `.xlsx` on the page. It's kept in the module, so names still work after a restart.

The first row holds the column names (or pick another row). If the sheet can't be reached, the last good copy keeps working.

**Naming.** Pick what goes in the name, in order: sheet columns, the date, the time, the connection's name, a take number, the row number, some text or a value from Companion. Choose what goes between them, how the date and time look, and what happens when a name's already taken (add (2), or a take number). The preview shows what the live row gives you. Fancy writing the pattern yourself? `{Session} - {Speaker} {date}` works too.

**Sheet row.** Which row is live, and why. Tap a row to make it live, or use **◀ PREVIOUS** / **NEXT ▶**. Also:

- **Next row after each recording:** steps on by itself when a take stops. Back-to-back sessions, sorted.
- **Match by time:** with start and end time columns, the row whose times cover now goes live by itself. A tap overrides it until the next slot (or until you press **RELEASE**: your choice).
- **Key column:** a column of codes (K1, P2...) so Companion can set the row by code.

**What happens on a take.** Just before the ATEM starts recording (from Companion, the page or a planned start), the ATEM is given the name from the live row (it adds its own number on the end). Once it's rolling, the ATEM's file name goes back to how it was. If you move to another row during the take, the file is renamed after stop, if I can reach the folder. Started on the ATEM itself? I still spot it. Sheet naming has an on/off switch, and while it's off the ATEM names its files as it always has.

**Upload.** Where to, when, and which folders:

- **Where:** Google Drive, Dropbox, OneDrive or anything else rclone knows; a network share or NAS (already connected); FTP or SFTP; WebDAV; or a web address (HTTP POST or PUT). Add as many as you like, each with its own login. Each file goes to each one that's on.
- **When:** after each recording stops (queued, and retried if the network drops); only when asked; or at a set time each day.
- **Folders:** one fixed folder; a folder with one per day inside it; or a pattern from sheet columns and the date, like `{Event}/{date}`.
- The upload is a copy. The recording stays put on this computer.

**rclone.** Google Drive, Dropbox, OneDrive, FTP and SFTP go through [rclone](https://rclone.org/downloads/), the same as Companion Sync, and it needs installing on the computer Companion runs on (Mac: `brew install rclone`; Windows: `winget install Rclone.Rclone`; Pi: `sudo -v ; curl https://rclone.org/install.sh | sudo bash`). Then set up a remote with `rclone config` and put its name in the destination (`gdrive:Shows`, say). If it's missing, the page tells you.

**Upload queue.** Everything waiting, going, done or failed, with progress. **UPLOAD NOW**, **RETRY FAILED**, **CLEAR DONE**, or retry and remove one at a time.

**Where are the files?** On the drive plugged into the ATEM, so the file manager, renaming and uploads need this computer to see it: see **Getting at the files** above. Renaming and deleting over a mounted FTP drive: not tried yet, and a Mac mounts FTP read-only.

From Companion:

- **Recordings: sheet row**: next, previous, set (by number or key-column value, variables welcome) or release
- **Recordings: upload now / retry failed / clear done**
- **Recordings: read the Google Sheet again now**
- **Recordings: sheet naming and uploads on / off**
- **Recordings: set a value for the name**: gives the name a value from a variable or expression, used as `{var:name}`
- feedbacks: **an upload has failed**, **uploading**, **a manual row pick is overriding the time match**, **the sheet can't be read**
- presets in **Recordings**: previous / next row, release, next take name, upload now, retry, read the sheet

### Auto gain

Each input has **auto level** (on/off) and **calibrate**.

- **This level please:** set it by ear, then capture that level as the target. Auto level leaves it alone while the level stays inside the band, and rides it back when it wanders out.
- **Calibrate:** brings the input to a set level once, then stops.
- **The input button** (the per-input preset "AG"): **press** = this level please, **double tap** = calibrate to the input's own level, **press and hold** = calibrate to the module level. Timings are in Settings → Buttons.

What it moves is up to you, per input:

- the **fader**: it measures after the fader
- the **trim** (Fairlight only): it measures before the fader, so the fader stays yours. Classic ATEMs have no trim, so they always ride the fader.

Every setting has a page-wide default (Settings → Auto gain defaults) and can be changed per input under Show advanced.

Heads up: if auto level moves the fader on an input, a Grid fader latched to that input lets go each time, because that counts as an outside move. Ride the trim instead and you keep both.

### Intech Grid faders

Use **Fader: from a value (Intech Grid fader), with pickup** in a trigger that runs when the Grid fader's value changes, with the fader's value as **Value**.

- Fader 1 drives the first input in the list, fader 2 the second, and so on, unless you give it an input. A variable in **Fader number** swaps banks.
- Pickup works as in the SQ module extension: catch band and dwell, then latched until the ATEM is moved elsewhere (release band and time).
- The catch and release settings belong to each connection, on the connection page under **Grid fader pickup**. A value typed into an action overrides it for that action only.
- Show it on the fader's LED with the **Grid fader pickup LED** feedback.

### Presets

**Overall:** open the page and its address, connection, update available, auto level on or off for every input, record, disk time left, next planned start, stream, AFV crossfade, reset peaks, pop-ups, and monitor dim (classic).

**Per input:** the AG button, auto level, status, this level, the two calibrates, mute, on and AFV, PFL, solo (hold and latch), level, fader ±1 / ±3 / 0, trim ±1, delay ±1 frame, and EQ / expander / compressor / limiter on/off (with their gain reduction), plus the backup switch. Only what that input has.

**Master and headphones:** the fader buttons, level, follow fade to black, and the master's EQ and dynamics.

### Action recorder

Companion's action recorder picks up changes made on the fader page, and on the ATEM itself (ATEM Software Control, the panel), as this module's actions: fader, trim, mute, on / off / AFV, balance, delay, PFL, and every EQ and dynamics setting.

### Variables

Per input, numbered in list order (`in1_` …):

- name, id, fader, trim, mute, on / off / AFV (`mix`), balance, delay
- PFL and backup state
- auto level status and target (`auto_level`, `auto_level_on`, `target`), calibrate level
- meters (`level`, `rms`, `peak`, `pre`), and gain reduction (`compressor_gr`, `limiter_gr`, `expander_gr`)
- every EQ and dynamics setting, e.g. `in1_band3_gain`, `in1_compressor_threshold`

Overall: `page_url`, `atem_model`, `atem_mixer`, `atem_protocol`, `atem_error`, `afv_crossfade`; recording: `rec_state`, `rec_time`, `rec_next`, `rec_countdown`, `rec_auto`, `rec_file_name`, `rec_disk`, `rec_remaining`, `rec_error`, `rec_iso`, `rec_folder`, `rec_folder_problem`, `rec_files`; streaming: `stream_state`, `stream_time`, `stream_bitrate`; `solo`, `notices`.

### Variables and expressions in actions and feedbacks

Companion fills in variables for me before an action or feedback runs. So text fields (an input, a dB value, a colour) take variables, such as `$(custom:mic_level)`, and every other field can be switched to an **expression** with the little toggle next to it. A few fields that decide what else is shown (like **Mode**) stay as plain choices, so the options underneath don't jump about.

Inputs can be given by name, by number in the list, or by id: `in1`, `in1301.2` (the second half of a split mic), `master`, `monitor`, `talkback`. Ids don't change when someone renames an input on the ATEM, so they're the safest bet for buttons.

### Driving the connection from a variable

Connection fields can't take variables, but you can still change them on the fly:

1. On the connection page, tick **Can be set by the action** next to each field you want to hand over. That field then locks on the page and shows what the action last set (the PIN stays hidden).
2. Add the **Connection: set settings** action. Its options are just the fields you ticked. Fill in the ones to change (variables and expressions welcome); leave a field blank to leave it as is.
3. To follow a variable, make a trigger on **variable changed** for that variable, with **Connection: set settings** as its action. Handy for swapping between a main and a spare ATEM.

When it runs, I write the new values into the connection and reconnect, or restart the fader page, as needed. A number field given something silly (not a number, not whole, or outside its range, like port 99999) is skipped, with a note in the log. Same for an address with a space in it.

Untick a field and it goes back to whatever you'd typed before you ticked it.

### Updates

I check GitHub for a newer ATEM Audio now and then (the connection page says how often; 0 = never) and tell you in the log, the page, the `module_update` variable and the **Update available** feedback.

I don't check for new ATEM software: Blackmagic don't publish it anywhere I can ask without guessing. The ATEM tells me its protocol version, though (`atem_protocol`), which says which ATEM software it's at least on.

### Good to know

- **Classic meters are home-made.** The ATEM library I use (atem-connection, the same one the official module uses) never asks classic ATEMs for their meters and throws the answer away. I add the two missing messages myself. It's built from the published protocol notes but hasn't met a real classic ATEM yet, so if your classic meters sit still, tell me. Everything else works without them, apart from auto level.
- Audio-only inputs (XLR, RCA, mic jacks, MADI) have no names on the ATEM, so I call them XLR 1, Mic 1 and so on, like the official module does.
- The page uses web fonts when online and falls back to built-in fonts at a venue with no internet. No drama when the Wi-Fi's down.
- Under the hood, ATEM Audio runs on the Rebels' shared audio core ([rebel-audio-core](https://github.com/nisted/rebel-audio-core)), the same one OBS Audio uses. A fix there lands in both.

### Psst. This one's got mates. 🍹

ATEM Audio is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. Want to know who else is in the crew, or grab the freshest version of each one? It's all here: [github.com/nisted/companion-modules](https://github.com/nisted/companion-modules)
