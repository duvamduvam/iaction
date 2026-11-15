<#
.SYNOPSIS
  Sessions Claude Code pilotées à distance (Remote Control) sur un poste Windows :
  relais en mode serveur pour IAction (T-180) et sessions partagées interactives.

.DESCRIPTION
  Trois instances par défaut, décrites dans relais-distant.json (créé au premier
  lancement, à côté du journal) :

    pc-bureau-relais  mode relais   `claude remote-control --name …` (IAction y crée
                                    une session neuve par conversation)
    pc-bureau         mode partage  `claude --remote-control …` dans le dépôt de travail
    pc-bureau-teams   mode partage  idem, avec le dossier de configuration .claude-teams

  Le script les maintient en vie :
    - à l'ouverture de session Windows ;
    - au RÉVEIL de veille (le poste dort souvent, il redémarre rarement) ;
    - à chaque connexion réseau (bureau / maison / 4G / VPN : la voie change) ;
    - toutes les 15 minutes : relance une instance morte, ou un relais déconnecté
      depuis 5 minutes ou plus.

  Choix de la voie réseau (direct ou proxy), sans aucune adresse écrite ici :
    1. Candidats : la voie retenue la dernière fois, puis l'accès direct, puis le
       proxy que Windows utiliserait pour https://api.anthropic.com (réglage  (audit-publication:ok — API publique)
       système, PAC ou WPAD compris).
    2. Chaque candidat est testé SANS les identifiants Windows : Claude Code ne
       sait pas s'authentifier auprès d'un proxy, un test qui les utiliserait
       réussirait là où Claude échoue. Un 407 élimine le candidat.
    3. Pour le relais, la preuve finale est le « Connected » affiché par Claude
       lui-même (sortie redirigée vers relais-<nom>.out.log) ; sans lui dans le
       délai, le relais est arrêté et la voie suivante essayée.
  La voie qui marche est mémorisée par instance et ré-essayée en premier.

  Une instance n'est relancée que si elle est morte ou si la voie a changé : un
  réveil sans changement ne coupe pas les sessions en cours. -Relancer force.

.EXAMPLE
  .\relais-distant.ps1                          # s'assure que toutes les instances tournent
  .\relais-distant.ps1 -Instance pc-bureau      # une seule instance
  .\relais-distant.ps1 -Relancer                # relance quoi qu'il arrive
  .\relais-distant.ps1 -Etat                    # état, voie et dernière ligne de connexion
  .\relais-distant.ps1 -Arreter                 # arrête (arbre de processus compris)
  .\relais-distant.ps1 -Installer               # tâche planifiée : session + réveil + réseau
  .\relais-distant.ps1 -Desinstaller            # retire la tâche planifiée
  .\relais-distant.ps1 -Proxy http://hote:port  # force un proxy candidat (sinon : Windows)
#>
[CmdletBinding(DefaultParameterSetName = 'Assurer')]
param(
  [Parameter(ParameterSetName = 'Relancer')] [switch]$Relancer,
  [Parameter(ParameterSetName = 'Etat')] [switch]$Etat,
  [Parameter(ParameterSetName = 'Arreter')] [switch]$Arreter,
  [Parameter(ParameterSetName = 'Installer')] [switch]$Installer,
  [Parameter(ParameterSetName = 'Desinstaller')] [switch]$Desinstaller,

  # Nom d'une instance du fichier de config ; vide = toutes les instances actives.
  [string]$Instance = '',
  # Dossier du script de travail : config, journal, état, sorties du relais.
  [string]$Base = (Join-Path $env:USERPROFILE 'iaction-relais'),
  # Proxy candidat imposé (sinon celui que Windows choisit pour l'API Claude).
  [string]$Proxy = '',
  # Exécutable Claude Code ; découvert tout seul si vide.
  [string]$Claude = '',
  # Fichier PEM d'une autorité interne, si le proxy inspecte le TLS.
  [string]$CertificatsSupplementaires = '',
  # Dossier des sessions partagées, utilisé seulement à la création de relais-distant.json.
  [string]$DossierPartage = '',
  # Taille de la sortie du relais au-delà de laquelle on le relance (s'il est inoccupé).
  [int]$TailleMaxSortieMo = 20,
  # Délai max d'attente du « Connected » d'un relais, en secondes.
  [int]$DelaiConnexion = 30
)

$ErrorActionPreference = 'Stop'
$NomTache = 'IAction - relais distant'
$Cible = 'https://api.anthropic.com'  # audit-publication:ok — API publique d'Anthropic
$ConfigFichier = Join-Path $Base 'relais-distant.json'
$EtatFichier = Join-Path $Base '.relais-etat.json'
$Journal = Join-Path $Base 'relais.log'
# Hôtes jamais envoyés au proxy. Ceux du réseau de CE poste (forge interne, services
# internes) ne s'écrivent JAMAIS ici, le dépôt est public : ils vivent dans
# sans-proxy.txt, à côté du journal (une entrée par ligne ou séparées par des
# virgules ; une ligne commençant par # est un commentaire).
$SansProxy = 'localhost,127.0.0.1,::1,.local'
$SansProxyFichier = Join-Path $Base 'sans-proxy.txt'
if (Test-Path $SansProxyFichier) {
  $extra = @((Get-Content $SansProxyFichier -Encoding UTF8) -split ',' |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
  if ($extra.Count -gt 0) { $SansProxy = $SansProxy + ',' + ($extra -join ',') }
}

New-Item -ItemType Directory -Force -Path $Base | Out-Null

function Ecrire([string]$niveau, [string]$message) {
  # Messages sans accents : lisibles même si le journal est rouvert en ANSI.
  $ligne = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $niveau, $message
  Add-Content -Path $Journal -Value $ligne -Encoding UTF8
  Write-Host $ligne
}

# --- Configuration des instances --------------------------------------------

function Config-Defaut {
  # Dépôt de travail des sessions partagées : -DossierPartage, sinon %USERPROFILE%\Projets
  # (à ajuster ensuite dans relais-distant.json).
  $depot = if ($DossierPartage) { $DossierPartage } else { Join-Path $env:USERPROFILE 'Projets' }
  @(
    [ordered]@{ nom = 'pc-bureau-relais'; mode = 'relais'; actif = $true
      dossier = (Join-Path $env:USERPROFILE 'iaction-relais'); permission = 'auto'; configDir = '' },
    [ordered]@{ nom = 'pc-bureau'; mode = 'partage'; actif = $true
      dossier = $depot; permission = 'bypassPermissions'; configDir = '' },
    [ordered]@{ nom = 'pc-bureau-teams'; mode = 'partage'; actif = $true
      dossier = $depot; permission = 'bypassPermissions'; configDir = '.claude-teams' }
  )
}

function Lire-Config {
  if (-not (Test-Path $ConfigFichier)) {
    Config-Defaut | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigFichier -Encoding UTF8
    Ecrire 'INFO' "Configuration par defaut ecrite : $ConfigFichier (a ajuster si besoin)."
  }
  # PowerShell 5.1 : ConvertFrom-Json rend le tableau d'un bloc ; le repasser dans
  # le pipeline l'enumere.
  $liste = @((Get-Content $ConfigFichier -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ })
  # Fichier réécrit par ConvertTo-Json -InputObject sous 5.1 : {"value":[...],"Count":n}.
  if ($liste.Count -eq 1 -and $liste[0].PSObject.Properties['value'] -and $liste[0].PSObject.Properties['Count']) {
    $liste = @($liste[0].value | ForEach-Object { $_ })
  }
  foreach ($i in $liste) {
    if ($i.mode -notin 'relais', 'partage') { throw "Instance '$($i.nom)' : mode '$($i.mode)' inconnu (relais ou partage)." }
  }
  if ($Instance) {
    $liste = @($liste | Where-Object { $_.nom -eq $Instance })
    if ($liste.Count -eq 0) { throw "Instance '$Instance' absente de $ConfigFichier." }
    return $liste
  }
  return @($liste | Where-Object { $_.actif })
}

function Lire-Etat {
  $e = @{}
  if (Test-Path $EtatFichier) {
    try {
      $j = Get-Content $EtatFichier -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($p in $j.PSObject.Properties) { $e[$p.Name] = $p.Value }
    } catch { }
  }
  return $e
}

function Ecrire-Etat($memo) {
  $memo | ConvertTo-Json -Depth 4 | Set-Content -Path $EtatFichier -Encoding UTF8
}

# --- Exécutable ---------------------------------------------------------------

function Trouver-Claude {
  if ($Claude -and (Test-Path $Claude)) { return $Claude }
  $candidats = @(
    (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
    (Join-Path $env:APPDATA 'npm\claude.cmd')
  )
  foreach ($c in $candidats) { if (Test-Path $c) { return $c } }
  $vscode = Get-ChildItem (Join-Path $env:USERPROFILE '.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($vscode) { return $vscode.FullName }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Claude Code introuvable (.local\bin, npm, extension VS Code, PATH). Passer -Claude <chemin>.'
}

# --- Voie réseau ----------------------------------------------------------------

function Libelle-Voie([string]$voie) { if ($voie) { "proxy $voie" } else { 'direct' } }

function Proxy-Windows {
  if ($Proxy) { return $Proxy.TrimEnd('/') }
  try {
    $u = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]$Cible)
    if ($u -and $u.AbsoluteUri.TrimEnd('/') -ne $Cible) { return $u.AbsoluteUri.TrimEnd('/') }
  } catch { Ecrire 'WARN' "Lecture du proxy Windows impossible : $($_.Exception.Message)" }
  return ''
}

function Tester-Voie([string]$voie) {
  # Sans identifiants Windows, comme Claude Code. Toute réponse HTTP sauf 407 prouve
  # que la voie passe (l'API répond 404 sur sa racine, c'est attendu).
  # HttpWebRequest et non Invoke-WebRequest : sous PowerShell 5.1, ce dernier passe
  # toujours par le proxy Windows, le « direct » n'en serait pas un.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $req = [Net.HttpWebRequest][Net.WebRequest]::Create($Cible)
  $req.Method = 'HEAD'
  $req.Timeout = 8000
  if ($voie) { $req.Proxy = New-Object Net.WebProxy($voie) } else { $req.Proxy = $null }
  try { $req.GetResponse().Close(); return 'ok' }
  catch {
    $r = $_.Exception.InnerException.Response
    if (-not $r) { $r = $_.Exception.Response }
    if ($r) {
      $code = [int]$r.StatusCode
      $r.Close()
      if ($code -eq 407) { return '407' }
      return 'ok'
    }
    return 'echec'
  }
}

function Voies-Candidates($retenue) {
  # Ordre : voie retenue la dernière fois, direct, proxy Windows ; sans doublon.
  # '' = accès direct. $retenue vaut $null quand rien n'est encore mémorisé.
  $liste = New-Object System.Collections.Generic.List[string]
  $ordre = @()
  if ($null -ne $retenue) { $ordre += $retenue }
  $ordre += ''
  $pw = Proxy-Windows
  if ($pw) { $ordre += $pw }
  foreach ($v in $ordre) { if (-not $liste.Contains($v)) { $liste.Add($v) } }
  return , $liste
}

function Voies-Utilisables($retenue) {
  $ok = New-Object System.Collections.Generic.List[string]
  foreach ($v in (Voies-Candidates $retenue)) {
    $t = Tester-Voie $v
    switch ($t) {
      'ok' { $ok.Add($v) }
      '407' { Ecrire 'WARN' "Voie $(Libelle-Voie $v) : le proxy exige une authentification (407), Claude Code ne sait pas la fournir." }
      default { Ecrire 'INFO' "Voie $(Libelle-Voie $v) : pas de reponse." }
    }
  }
  return , $ok
}

function Appliquer-Voie([string]$voie, [string]$configDir) {
  # Variables héritées par le seul processus lancé (aucun réglage global).
  foreach ($v in 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy') {
    if ($voie) { Set-Item "env:$v" $voie } else { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
  }
  $env:NO_PROXY = $SansProxy
  $env:no_proxy = $SansProxy
  if ($CertificatsSupplementaires) { $env:NODE_EXTRA_CA_CERTS = $CertificatsSupplementaires }
  if ($configDir) { $env:CLAUDE_CONFIG_DIR = Join-Path $env:USERPROFILE $configDir }
  else { Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}

# --- Processus ------------------------------------------------------------------

function Motif-Instance($i) {
  $n = [regex]::Escape($i.nom)
  if ($i.mode -eq 'relais') { return "remote-control\s+--name\s+`"?$n`"?(\s|$)" }
  return "--remote-control\s+`"?$n`"?(\s|$)"
}

function Instances-Vivantes($i) {
  # Appeler sous @(...) : sous PowerShell 5.1, une fonction qui rend un seul objet
  # CIM le deroule, et .Count de cet objet ne vaut pas 1.
  $motif = Motif-Instance $i
  @(Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $motif -and $_.CommandLine -notmatch '\s-p\s' })
}

function Arreter-Instance($i) {
  $vivants = @(Instances-Vivantes $i)
  foreach ($x in $vivants) {
    Ecrire 'INFO' "$($i.nom) : arret (pid $($x.ProcessId), arbre compris)"
    # claude.exe relance un second claude.exe sous lui : on arrete tout l'arbre.
    & taskkill.exe /PID $x.ProcessId /T /F 2>&1 | Out-Null
  }
  return $vivants.Count
}

function Fichier-Sortie($i) { Join-Path $Base ("relais-{0}.out.log" -f $i.nom) }

function Attendre-Connexion($i, $proc) {
  $sortie = Fichier-Sortie $i
  $fin = (Get-Date).AddSeconds($DelaiConnexion)
  while ((Get-Date) -lt $fin) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited) { return 'mort' }
    if (Test-Path $sortie) {
      $txt = Get-Content $sortie -Raw -ErrorAction SilentlyContinue
      if ($txt -match '\bConnected\b') { return 'connecte' }
    }
  }
  return 'muet'
}

function Minutes-Decroche($i) {
  # Relais vivant mais décroché : Claude affiche « disconnected 9m 16s » en retentant
  # seul. Rend la durée en minutes (0 si connecté ou si rien n'est lisible).
  if ($i.mode -ne 'relais') { return 0 }
  $f = Fichier-Sortie $i
  if (-not (Test-Path $f)) { return 0 }
  $l = Select-String -Path $f -Pattern 'Connected|Reconnecting|Disconnected|disconnected' | Select-Object -Last 1
  if (-not $l -or $l.Line -notmatch 'disconnected\s+(?:(\d+)h\s*)?(\d+)m') { return 0 }
  $h = if ($Matches[1]) { [int]$Matches[1] } else { 0 }
  return $h * 60 + [int]$Matches[2]
}

function Journal-Sature($i) {
  # L'interface du relais se redessine sans cesse : sa sortie grossit d'environ
  # 1,5 Mo par heure et reste ouverte tant qu'il tourne. Au-delà du plafond, on le
  # relance (ce qui la vide), mais seulement s'il ne porte aucune session.
  if ($i.mode -ne 'relais') { return $false }
  $f = Fichier-Sortie $i
  if (-not (Test-Path $f)) { return $false }
  if ((Get-Item $f).Length -lt ($TailleMaxSortieMo * 1MB)) { return $false }
  $l = Select-String -Path $f -Pattern 'Capacity:\s*(\d+)/' | Select-Object -Last 1
  return ($l -and $l.Matches[0].Groups[1].Value -eq '0')
}

function Lancer-Instance($i, [string]$voie) {
  $exe = Trouver-Claude
  if (-not (Test-Path $i.dossier)) { throw "$($i.nom) : dossier introuvable ($($i.dossier))." }
  Appliquer-Voie $voie $i.configDir

  if ($i.mode -eq 'relais') {
    $arguments = @('remote-control', '--name', $i.nom, '--permission-mode', $i.permission)
    $sortie = Fichier-Sortie $i
    Remove-Item $sortie, "$sortie.err" -ErrorAction SilentlyContinue
    # Sortie redirigée : le « Connected » de Claude est la preuve que la voie marche.
    # La redirection passe par cmd.exe, lancé dans SA PROPRE console cachée : un
    # Start-Process -RedirectStandardOutput rattacherait le relais à la console de
    # l'appelant, et fermer cette fenêtre PowerShell tuerait le relais.
    $ligne = '"{0}" {1} > "{2}" 2> "{2}.err"' -f $exe, (($arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '), $sortie
    $proc = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c `"$ligne`"" -WorkingDirectory $i.dossier `
      -WindowStyle Hidden -PassThru
    Ecrire 'INFO' "$($i.nom) : lance (pid $($proc.Id), $(Libelle-Voie $voie), dossier $($i.dossier))"
    $r = Attendre-Connexion $i $proc
    if ($r -eq 'connecte') { Ecrire 'INFO' "$($i.nom) : Connected."; return $true }
    $err = (Get-Content "$sortie.err" -Raw -ErrorAction SilentlyContinue)
    if ($err) { Ecrire 'WARN' "$($i.nom) : erreur Claude : $($err.Trim() -replace '\s+', ' ')" }
    if ($r -eq 'mort') { Ecrire 'WARN' "$($i.nom) : arrete aussitot avec la voie $(Libelle-Voie $voie)." }
    else { Ecrire 'WARN' "$($i.nom) : pas de Connected en $DelaiConnexion s avec la voie $(Libelle-Voie $voie)." }
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
    return $false
  }

  # Mode partage : session interactive, il lui faut une vraie console (fenêtre
  # réduite). Pas de sortie lisible : la voie a été validée par Tester-Voie.
  $permission = if ($i.permission -eq 'bypassPermissions') { @('--dangerously-skip-permissions') }
                else { @('--permission-mode', $i.permission) }
  $arguments = @('--remote-control', $i.nom) + $permission
  $proc = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $i.dossier `
    -WindowStyle Minimized -PassThru
  Ecrire 'INFO' "$($i.nom) : lance (pid $($proc.Id), $(Libelle-Voie $voie), dossier $($i.dossier))"
  Start-Sleep -Seconds 8
  if ($proc.HasExited) {
    Ecrire 'WARN' "$($i.nom) : arrete aussitot avec la voie $(Libelle-Voie $voie). Le lancer une fois a la main dans $($i.dossier) pour voir l'erreur."
    return $false
  }
  return $true
}

function Assurer-Instance($i, $memo) {
  $e = $memo[$i.nom]
  $retenue = if ($e) { "$($e.voie)" } else { $null }
  $voies = Voies-Utilisables $retenue
  if ($voies.Count -eq 0) { throw "$($i.nom) : aucune voie vers $Cible (direct et proxy en echec). Reseau absent ?" }

  $vivants = @(Instances-Vivantes $i)
  $decroche = if ($vivants.Count -gt 0) { Minutes-Decroche $i } else { 0 }
  $sature = ($vivants.Count -gt 0) -and (Journal-Sature $i)
  if ($vivants.Count -gt 0 -and -not $Relancer -and $decroche -lt 5 -and -not $sature -and $e -and ($voies -contains "$($e.voie)")) {
    Ecrire 'INFO' "$($i.nom) : deja en cours, voie $(Libelle-Voie $e.voie) toujours valide. Rien a faire."
    return
  }
  if ($vivants.Count -gt 0) {
    $raison = if ($Relancer) { 'relance demandee' }
              elseif ($decroche -ge 5) { "deconnecte depuis $decroche min" }
              elseif ($sature) { "sortie au-dela de $TailleMaxSortieMo Mo, aucune session ouverte" }
              else { 'voie precedente plus valide' }
    Ecrire 'INFO' "$($i.nom) : relance ($raison)."
    Arreter-Instance $i | Out-Null
    Start-Sleep -Seconds 2
  }

  foreach ($v in $voies) {
    if (Lancer-Instance $i $v) {
      $memo[$i.nom] = @{ voie = $v; lance = (Get-Date).ToString('o') }
      Ecrire-Etat $memo
      return
    }
    Arreter-Instance $i | Out-Null
  }
  throw "$($i.nom) : aucune voie n'a abouti. Voir $Journal et $(Fichier-Sortie $i).err"
}

# --- Tâche planifiée -------------------------------------------------------------

function Installer-Tache {
  $script = $PSCommandPath
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $argsTache = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Base `"$Base`""
  if ($Proxy) { $argsTache += " -Proxy `"$Proxy`"" }
  if ($Claude) { $argsTache += " -Claude `"$Claude`"" }
  if ($CertificatsSupplementaires) { $argsTache += " -CertificatsSupplementaires `"$CertificatsSupplementaires`"" }
  $esc = [System.Security.SecurityElement]

  # Réveil : Power-Troubleshooter, événement 1. Réseau : NetworkProfile, 10000 (connexion).
  $reveil = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
  $reseau = "<QueryList><Query Id='0' Path='Microsoft-Windows-NetworkProfile/Operational'><Select Path='Microsoft-Windows-NetworkProfile/Operational'>*[System[EventID=10000]]</Select></Query></QueryList>"

  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><!-- audit-publication:ok -->
  <RegistrationInfo><Description>Sessions Claude Code Remote Control (relais IAction et sessions partagees) : ouverture de session, reveil, changement de reseau.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$($esc::Escape($user))</UserId><Delay>PT30S</Delay></LogonTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>$($esc::Escape($reveil))</Subscription><Delay>PT20S</Delay></EventTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>$($esc::Escape($reseau))</Subscription><Delay>PT15S</Delay></EventTrigger>
    <TimeTrigger><Repetition><Interval>PT15M</Interval></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$($esc::Escape($user))</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>$($esc::Escape($argsTache))</Arguments></Exec></Actions>
</Task>
"@
  Register-ScheduledTask -TaskName $NomTache -Xml $xml -Force | Out-Null
  Ecrire 'INFO' "Tache planifiee '$NomTache' installee (ouverture de session, reveil, changement de reseau, controle toutes les 15 min)."
  Write-Host "Pour la lancer tout de suite : Start-ScheduledTask -TaskName '$NomTache'"
}

# ---------------------------------------------------------------------------------

try {
  switch ($PSCmdlet.ParameterSetName) {
    'Installer' { Installer-Tache; break }
    'Desinstaller' {
      Unregister-ScheduledTask -TaskName $NomTache -Confirm:$false -ErrorAction SilentlyContinue
      Ecrire 'INFO' "Tache planifiee '$NomTache' retiree."
      break
    }
    'Arreter' {
      $n = 0
      foreach ($i in (Lire-Config)) { $n += Arreter-Instance $i }
      if ($n -eq 0) { Ecrire 'INFO' 'Aucune instance en cours.' }
      break
    }
    'Etat' {
      $memo = Lire-Etat
      foreach ($i in (Lire-Config)) {
        $v = @(Instances-Vivantes $i)
        $statut = if ($v.Count -eq 0) { 'ARRETE' } else { "en cours (pid $($v.ProcessId -join ', '))" }
        Write-Host ("{0} [{1}] : {2}" -f $i.nom, $i.mode, $statut)
        $e = $memo[$i.nom]
        if ($e) { Write-Host ("  dernier lancement : {0}, voie : {1}" -f $e.lance, (Libelle-Voie "$($e.voie)")) }
        if ($i.mode -eq 'relais' -and (Test-Path (Fichier-Sortie $i))) {
          $l = Select-String -Path (Fichier-Sortie $i) -Pattern 'Connected|Connecting|Reconnecting|Disconnected|error' | Select-Object -Last 1
          # Sortie d'interface terminal : on retire les sequences ANSI avant affichage.
          if ($l) { Write-Host ("  derniere ligne de connexion : {0}" -f ($l.Line -replace '\x1b\[[0-9;?]*[A-Za-z]', '').Trim()) }
        }
      }
      $t = Get-ScheduledTask -TaskName $NomTache -ErrorAction SilentlyContinue
      Write-Host ("Tache planifiee : {0}" -f ($(if ($t) { $t.State } else { 'non installee' })))
      Write-Host "Journal : $Journal"
      break
    }
    default {
      $memo = Lire-Etat
      $echecs = 0
      foreach ($i in (Lire-Config)) {
        try { Assurer-Instance $i $memo }
        catch { Ecrire 'ERROR' $_.Exception.Message; $echecs++ }
      }
      if ($echecs -gt 0) { exit 1 }
    }
  }
} catch {
  Ecrire 'ERROR' $_.Exception.Message
  exit 1
}
