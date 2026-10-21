use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const ATTEMPT_FILE: &str = "update-attempt.json";
const ATTEMPT_TEMP_FILE: &str = "update-attempt.tmp";
const ATTEMPT_ARGUMENT: &str = "--ghosteranti-update-attempt=";
const ATTEMPT_SCHEMA: u8 = 1;
const MANUFACTURER_KEY: &str = r"Software\ghosteranti\GhosterAnti";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\GhosterAnti";
const MAX_REGISTRY_STRING_BYTES: u32 = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerHandoff {
    pub id: String,
    pub canonical_root: PathBuf,
    nsis_root: PathBuf,
}

impl InstallerHandoff {
    pub fn prepare() -> Result<Self, UpdateAttemptError> {
        let executable = std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
        let canonical_executable =
            fs::canonicalize(executable).map_err(|_| UpdateAttemptError::RunningPath)?;
        // Windows updates an install directory; macOS replaces the whole app bundle and
        // Linux the whole app folder.
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let canonical_root = canonical_executable
            .parent()
            .ok_or(UpdateAttemptError::RunningPath)?
            .to_path_buf();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let canonical_root =
            install_root(&canonical_executable).ok_or(UpdateAttemptError::RunningPath)?;
        #[cfg(target_os = "linux")]
        ensure_replaceable(&canonical_root)?;
        Ok(Self {
            id: hex::encode(rand::random::<[u8; 16]>()),
            nsis_root: normal_windows_path(&canonical_root),
            canonical_root,
        })
    }

    pub fn relaunch_argument(&self) -> OsString {
        format!("{ATTEMPT_ARGUMENT}{}", self.id).into()
    }

    pub fn installer_arguments(&self) -> [OsString; 2] {
        [
            format!("/AMATTEMPT={}", self.id).into(),
            nsis_directory_argument(&self.nsis_root),
        ]
    }
}

/// The `.app` bundle that holds this executable (`GhosterAnti.app/Contents/MacOS/ghosteranti`).
/// A copy that macOS runs from a read-only translocated path cannot be replaced.
#[cfg(target_os = "macos")]
fn macos_bundle(executable: &Path) -> Option<PathBuf> {
    let bundle = executable.ancestors().nth(3)?;
    (bundle.extension() == Some(OsStr::new("app"))
        && !bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation"))
    .then(|| bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn install_root(executable: &Path) -> Option<PathBuf> {
    macos_bundle(executable)
}

/// The Linux app folder that holds this executable: `bin/ghosteranti`, with resources in `lib`.
#[cfg(target_os = "linux")]
fn install_root(executable: &Path) -> Option<PathBuf> {
    let bin = executable.parent()?;
    let root = bin.parent()?;
    (bin.file_name() == Some(OsStr::new("bin")) && root.join("lib").is_dir())
        .then(|| root.to_path_buf())
}

/// The swap renames the app folder inside its parent, so that parent must be writable.
/// Checked before the update closes any browser.
#[cfg(target_os = "linux")]
fn ensure_replaceable(root: &Path) -> Result<(), UpdateAttemptError> {
    let parent = root.parent().ok_or(UpdateAttemptError::RunningPath)?;
    let probe = parent.join(format!(".ghosteranti-update-check-{}", std::process::id()));
    File::create(&probe).map_err(|_| UpdateAttemptError::RunningPath)?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Starts a detached shell that opens the replaced app once this process is gone.
/// The single-instance guard would hand an earlier relaunch to the old process.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn spawn_relaunch_after_exit(
    handoff: &InstallerHandoff,
) -> std::io::Result<std::process::Child> {
    use std::{
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };
    #[cfg(target_os = "macos")]
    let (start, target) = (
        r#"exec /usr/bin/open -n "$2" --args "$3""#,
        handoff.canonical_root.clone(),
    );
    #[cfg(target_os = "linux")]
    let (start, target) = (
        r#"exec "$2" "$3""#,
        handoff.canonical_root.join("bin").join("ghosteranti"),
    );
    Command::new("/bin/sh")
        .args([
            "-c",
            &format!(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; {start}"#),
            "sh",
        ])
        .arg(std::process::id().to_string())
        .arg(target)
        .arg(handoff.relaunch_argument())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
}

fn nsis_directory_argument(path: &Path) -> OsString {
    let mut argument = OsString::from("/D=");
    argument.push(path);
    argument
}

fn normal_windows_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    text.strip_prefix(r"\\?\UNC\")
        .map(|path| PathBuf::from(format!(r"\\{path}")))
        .or_else(|| text.strip_prefix(r"\\?\").map(PathBuf::from))
        .unwrap_or_else(|| path.to_path_buf())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaunchArgument {
    Missing,
    Valid(String),
    Invalid,
}

pub fn parse_relaunch_argument<I, S>(arguments: I) -> RelaunchArgument
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut values = arguments.into_iter().filter_map(|argument| {
        argument
            .as_ref()
            .to_string_lossy()
            .strip_prefix(ATTEMPT_ARGUMENT)
            .map(str::to_owned)
    });
    let Some(value) = values.next() else {
        return RelaunchArgument::Missing;
    };
    if values.next().is_some() || !valid_attempt_id(&value) {
        return RelaunchArgument::Invalid;
    }
    RelaunchArgument::Valid(value)
}

fn valid_attempt_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFailureReason {
    BrowserCleanup,
    InstallerLaunch,
    InstallationUnconfirmed,
    StartupMismatch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StoredAttemptState {
    Pending,
    Succeeded,
    InstalledRelaunchUnconfirmed,
    FailedOrInterrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredUpdateAttempt {
    schema_version: u8,
    id: String,
    source_version: String,
    expected_version: String,
    expected_root: PathBuf,
    state: StoredAttemptState,
    failure_reason: Option<UpdateFailureReason>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LastUpdateResult {
    Succeeded {
        #[serde(rename = "fromVersion")]
        from_version: String,
        version: String,
    },
    InstalledRelaunchUnconfirmed {
        version: String,
    },
    FailedOrInterrupted {
        #[serde(rename = "fromVersion")]
        from_version: String,
        #[serde(rename = "expectedVersion")]
        expected_version: String,
        reason: UpdateFailureReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateAttemptError {
    RunningPath,
    RegistrationUnavailable,
    RegistrationMismatch,
    Persistence,
    InvalidRecord,
}

impl std::fmt::Display for UpdateAttemptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::RunningPath => "the running installation path was unavailable",
            Self::RegistrationUnavailable => {
                "the Windows installation registration was unavailable"
            }
            Self::RegistrationMismatch => {
                "the running installation did not match its Windows registration"
            }
            Self::Persistence => "the update attempt could not be stored",
            Self::InvalidRecord => "the stored update attempt was invalid",
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistrationSnapshot {
    manufacturer_root: Option<String>,
    install_location: Option<String>,
    uninstall_string: Option<String>,
    main_binary_name: Option<String>,
    display_version: Option<String>,
}

pub fn validate_registered_install(
    handoff: &InstallerHandoff,
    current_version: &str,
) -> Result<(), UpdateAttemptError> {
    let executable = std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
    validate_registration_snapshot(
        &executable,
        current_version,
        &read_registration_snapshot()?,
        Some(&handoff.canonical_root),
    )
    .map(|_| ())
}

fn validate_registration_snapshot(
    executable: &Path,
    current_version: &str,
    registration: &RegistrationSnapshot,
    expected_root: Option<&Path>,
) -> Result<PathBuf, UpdateAttemptError> {
    let executable = fs::canonicalize(executable).map_err(|_| UpdateAttemptError::RunningPath)?;
    let root = executable
        .parent()
        .ok_or(UpdateAttemptError::RunningPath)?
        .to_path_buf();
    if expected_root.is_some_and(|expected| !same_windows_path(expected, &root)) {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }

    let manufacturer_root =
        canonical_registered_path(registration.manufacturer_root.as_deref(), false)?;
    let install_location =
        canonical_registered_path(registration.install_location.as_deref(), false)?;
    let uninstall = canonical_registered_path(registration.uninstall_string.as_deref(), true)?;
    let expected_uninstall = fs::canonicalize(root.join("uninstall.exe"))
        .map_err(|_| UpdateAttemptError::RegistrationMismatch)?;
    let executable_name = executable
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(UpdateAttemptError::RunningPath)?;

    if !same_windows_path(&root, &manufacturer_root)
        || !same_windows_path(&root, &install_location)
        || !same_windows_path(&expected_uninstall, &uninstall)
        || !registration
            .main_binary_name
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(executable_name))
        || registration.display_version.as_deref() != Some(current_version)
    {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }
    Ok(root)
}

fn canonical_registered_path(
    value: Option<&str>,
    file: bool,
) -> Result<PathBuf, UpdateAttemptError> {
    let value = value
        .and_then(strip_optional_quotes)
        .ok_or(UpdateAttemptError::RegistrationUnavailable)?;
    let path = fs::canonicalize(value).map_err(|_| UpdateAttemptError::RegistrationMismatch)?;
    if (file && !path.is_file()) || (!file && !path.is_dir()) {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }
    Ok(path)
}

fn strip_optional_quotes(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(value) = value.strip_prefix('"') {
        return value.strip_suffix('"').filter(|value| !value.is_empty());
    }
    (!value.ends_with('"')).then_some(value)
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    normal_windows_path(left)
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&normal_windows_path(right).as_os_str().to_string_lossy())
}

#[cfg(windows)]
fn read_registration_snapshot() -> Result<RegistrationSnapshot, UpdateAttemptError> {
    Ok(RegistrationSnapshot {
        manufacturer_root: read_current_user_registry_string(MANUFACTURER_KEY, None)?,
        install_location: read_current_user_registry_string(
            UNINSTALL_KEY,
            Some("InstallLocation"),
        )?,
        uninstall_string: read_current_user_registry_string(
            UNINSTALL_KEY,
            Some("UninstallString"),
        )?,
        main_binary_name: read_current_user_registry_string(UNINSTALL_KEY, Some("MainBinaryName"))?,
        display_version: read_current_user_registry_string(UNINSTALL_KEY, Some("DisplayVersion"))?,
    })
}

#[cfg(windows)]
fn read_current_user_registry_string(
    subkey: &str,
    value_name: Option<&str>,
) -> Result<Option<String>, UpdateAttemptError> {
    use std::ffi::c_void;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
            System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
        },
    };

    let subkey: Vec<u16> = subkey.encode_utf16().chain(Some(0)).collect();
    let value_name: Option<Vec<u16>> =
        value_name.map(|value| value.encode_utf16().chain(Some(0)).collect());
    let value_name = value_name
        .as_ref()
        .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr()));
    let mut byte_count = 0_u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            value_name,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut byte_count),
        )
    };
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS || byte_count == 0 || byte_count > MAX_REGISTRY_STRING_BYTES {
        return Err(UpdateAttemptError::RegistrationUnavailable);
    }

    let mut value = vec![0_u16; byte_count.div_ceil(2) as usize];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            value_name,
            RRF_RT_REG_SZ,
            None,
            Some(value.as_mut_ptr().cast::<c_void>()),
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS || byte_count as usize > value.len() * 2 {
        return Err(UpdateAttemptError::RegistrationUnavailable);
    }
    value.truncate(byte_count.div_ceil(2) as usize);
    while value.last() == Some(&0) {
        value.pop();
    }
    String::from_utf16(&value)
        .map(Some)
        .map_err(|_| UpdateAttemptError::RegistrationUnavailable)
}

#[cfg(not(windows))]
fn read_registration_snapshot() -> Result<RegistrationSnapshot, UpdateAttemptError> {
    Err(UpdateAttemptError::RegistrationUnavailable)
}

pub fn begin_attempt(
    data_dir: &Path,
    handoff: &InstallerHandoff,
    source_version: &str,
    expected_version: &str,
) -> Result<(), UpdateAttemptError> {
    write_attempt(
        data_dir,
        &StoredUpdateAttempt {
            schema_version: ATTEMPT_SCHEMA,
            id: handoff.id.clone(),
            source_version: source_version.to_owned(),
            expected_version: expected_version.to_owned(),
            expected_root: handoff.canonical_root.clone(),
            state: StoredAttemptState::Pending,
            failure_reason: None,
        },
    )
}

pub fn record_failure(
    data_dir: &Path,
    attempt_id: &str,
    reason: UpdateFailureReason,
) -> Result<(), UpdateAttemptError> {
    let Some(mut attempt) = read_attempt(data_dir)? else {
        return Err(UpdateAttemptError::InvalidRecord);
    };
    if attempt.id != attempt_id || !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    attempt.state = StoredAttemptState::FailedOrInterrupted;
    attempt.failure_reason = Some(reason);
    write_attempt(data_dir, &attempt)
}

#[derive(Debug, Clone, Copy)]
struct ReconciliationEvidence {
    marker_matches: bool,
    registration_matches: bool,
    current_version_matches: bool,
    relaunch_matches: bool,
}

fn apply_reconciliation(attempt: &mut StoredUpdateAttempt, evidence: ReconciliationEvidence) {
    if evidence.marker_matches
        && evidence.registration_matches
        && evidence.current_version_matches
        && evidence.relaunch_matches
    {
        attempt.state = StoredAttemptState::Succeeded;
        attempt.failure_reason = None;
    } else if evidence.marker_matches
        && evidence.registration_matches
        && evidence.current_version_matches
    {
        attempt.state = StoredAttemptState::InstalledRelaunchUnconfirmed;
        attempt.failure_reason = None;
    } else {
        attempt.state = StoredAttemptState::FailedOrInterrupted;
        attempt
            .failure_reason
            .get_or_insert(if evidence.marker_matches {
                UpdateFailureReason::StartupMismatch
            } else {
                UpdateFailureReason::InstallationUnconfirmed
            });
    }
}

pub fn reconcile_after_startup(
    data_dir: &Path,
    relaunch: &RelaunchArgument,
) -> Result<(), UpdateAttemptError> {
    let Some(mut attempt) = read_attempt(data_dir)? else {
        return Ok(());
    };
    if !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    if attempt.state == StoredAttemptState::Succeeded {
        return Ok(());
    }

    let current_executable =
        std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
    // macOS and Linux have no installer marker or registry: the proof is the same bundle
    // or folder path now running the expected version. An unchanged version means nothing
    // was installed.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (marker_matches, registration_matches) = {
        let same_root = fs::canonicalize(&current_executable)
            .ok()
            .and_then(|executable| install_root(&executable))
            .is_some_and(|root| root == attempt.expected_root);
        (
            same_root && env!("CARGO_PKG_VERSION") == attempt.expected_version,
            same_root,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let marker_matches =
        read_marker(&attempt).is_ok_and(|version| version == attempt.expected_version);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let registration_matches = read_registration_snapshot()
        .and_then(|registration| {
            validate_registration_snapshot(
                &current_executable,
                &attempt.expected_version,
                &registration,
                Some(&attempt.expected_root),
            )
        })
        .is_ok();
    let current_version_matches = env!("CARGO_PKG_VERSION") == attempt.expected_version;
    let relaunch_matches = matches!(relaunch, RelaunchArgument::Valid(id) if id == &attempt.id);

    apply_reconciliation(
        &mut attempt,
        ReconciliationEvidence {
            marker_matches,
            registration_matches,
            current_version_matches,
            relaunch_matches,
        },
    );
    write_attempt(data_dir, &attempt)?;
    if attempt.state == StoredAttemptState::Succeeded {
        let _ = fs::remove_file(marker_path(&attempt));
    }
    Ok(())
}

fn read_marker(attempt: &StoredUpdateAttempt) -> Result<String, UpdateAttemptError> {
    let mut value = String::new();
    File::open(marker_path(attempt))
        .and_then(|mut file| file.read_to_string(&mut value))
        .map_err(|_| UpdateAttemptError::InvalidRecord)?;
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    Ok(value.to_owned())
}

fn marker_path(attempt: &StoredUpdateAttempt) -> PathBuf {
    attempt
        .expected_root
        .join(format!(".ghosteranti-update-{}.complete", attempt.id))
}

pub fn last_update_result(data_dir: &Path) -> Result<Option<LastUpdateResult>, UpdateAttemptError> {
    let Some(attempt) = read_attempt(data_dir)? else {
        return Ok(None);
    };
    if !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    Ok(Some(match attempt.state {
        StoredAttemptState::Succeeded => LastUpdateResult::Succeeded {
            from_version: attempt.source_version,
            version: attempt.expected_version,
        },
        StoredAttemptState::InstalledRelaunchUnconfirmed => {
            LastUpdateResult::InstalledRelaunchUnconfirmed {
                version: attempt.expected_version,
            }
        }
        StoredAttemptState::Pending | StoredAttemptState::FailedOrInterrupted => {
            LastUpdateResult::FailedOrInterrupted {
                from_version: attempt.source_version,
                expected_version: attempt.expected_version,
                reason: attempt
                    .failure_reason
                    .unwrap_or(UpdateFailureReason::InstallationUnconfirmed),
            }
        }
    }))
}

fn valid_stored_attempt(attempt: &StoredUpdateAttempt) -> bool {
    attempt.schema_version == ATTEMPT_SCHEMA
        && valid_attempt_id(&attempt.id)
        && !attempt.source_version.is_empty()
        && attempt.source_version.len() <= 64
        && !attempt.expected_version.is_empty()
        && attempt.expected_version.len() <= 64
        && attempt.expected_root.is_absolute()
}

fn read_attempt(data_dir: &Path) -> Result<Option<StoredUpdateAttempt>, UpdateAttemptError> {
    let path = data_dir.join(ATTEMPT_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UpdateAttemptError::Persistence),
    };
    if bytes.len() > 16 * 1024 {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| UpdateAttemptError::InvalidRecord)
}

fn write_attempt(data_dir: &Path, attempt: &StoredUpdateAttempt) -> Result<(), UpdateAttemptError> {
    fs::create_dir_all(data_dir).map_err(|_| UpdateAttemptError::Persistence)?;
    let bytes = serde_json::to_vec(attempt).map_err(|_| UpdateAttemptError::Persistence)?;
    let temp_path = data_dir.join(ATTEMPT_TEMP_FILE);
    let target_path = data_dir.join(ATTEMPT_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .map_err(|_| UpdateAttemptError::Persistence)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| UpdateAttemptError::Persistence)?;
    drop(file);
    replace_file(&temp_path, &target_path)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), UpdateAttemptError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| UpdateAttemptError::Persistence)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), UpdateAttemptError> {
    fs::rename(source, destination).map_err(|_| UpdateAttemptError::Persistence)
}

/// Replaces the Linux app folder with the one in a verified `.tar.gz` update archive, whose
/// single top folder holds `bin/ghosteranti`. The new folder is unpacked beside the old one,
/// so both renames stay on one file system, and a failed step leaves the old folder in place.
#[cfg(target_os = "linux")]
pub fn replace_linux_install(root: &Path, archive: &[u8]) -> std::io::Result<()> {
    use std::{
        io::{Error, ErrorKind},
        path::Component,
    };
    let parent = root
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "app folder has no parent"))?;
    let name = root
        .file_name()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "app folder has no name"))?
        .to_string_lossy();
    let staging = parent.join(format!(".{name}-update"));
    let previous = parent.join(format!(".{name}-previous"));
    for leftover in [&staging, &previous] {
        if leftover.exists() {
            fs::remove_dir_all(leftover)?;
        }
    }
    fs::create_dir(&staging)?;
    let unpacked = (|| {
        let mut entries = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        entries.set_preserve_permissions(true);
        for entry in entries.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            let mut parts = path.components();
            if !matches!(parts.next(), Some(Component::Normal(_))) {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "update entry outside its folder",
                ));
            }
            let inner: PathBuf = parts.collect();
            if inner
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "update entry outside its folder",
                ));
            }
            if inner.as_os_str().is_empty() {
                continue;
            }
            let target = staging.join(&inner);
            if let Some(directory) = target.parent() {
                fs::create_dir_all(directory)?;
            }
            entry.unpack(&target)?;
        }
        if !staging.join("bin").join("ghosteranti").is_file() {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "update has no GhosterAnti program",
            ));
        }
        Ok(())
    })();
    if let Err(error) = unpacked {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(root, &previous) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, root) {
        let _ = fs::rename(&previous, root);
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    // The running program keeps its open files; the old folder is no longer needed.
    let _ = fs::remove_dir_all(&previous);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_registered_install() -> (tempfile::TempDir, PathBuf, RegistrationSnapshot) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("GhosterAnti install");
        fs::create_dir(&root).unwrap();
        let executable = root.join("GhosterAnti.exe");
        let uninstall = root.join("uninstall.exe");
        fs::write(&executable, b"app").unwrap();
        fs::write(&uninstall, b"uninstall").unwrap();
        let quoted_root = format!("\"{}\"", root.display());
        let registration = RegistrationSnapshot {
            manufacturer_root: Some(root.display().to_string()),
            install_location: Some(quoted_root),
            uninstall_string: Some(format!("\"{}\"", uninstall.display())),
            main_binary_name: Some("GhosterAnti.exe".to_owned()),
            display_version: Some("0.1.0-beta.47".to_owned()),
        };
        (directory, executable, registration)
    }

    fn handoff(root: &Path) -> InstallerHandoff {
        InstallerHandoff {
            id: "0123456789abcdef0123456789abcdef".to_owned(),
            canonical_root: root.to_path_buf(),
            nsis_root: normal_windows_path(root),
        }
    }

    fn stored_attempt(root: &Path) -> StoredUpdateAttempt {
        StoredUpdateAttempt {
            schema_version: ATTEMPT_SCHEMA,
            id: "0123456789abcdef0123456789abcdef".to_owned(),
            source_version: "0.1.0-beta.46".to_owned(),
            expected_version: "0.1.0-beta.47".to_owned(),
            expected_root: root.to_path_buf(),
            state: StoredAttemptState::Pending,
            failure_reason: None,
        }
    }

    #[test]
    fn accepts_only_one_lowercase_attempt_argument() {
        let valid = "--ghosteranti-update-attempt=0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_relaunch_argument([valid]),
            RelaunchArgument::Valid("0123456789abcdef0123456789abcdef".to_owned())
        );
        assert_eq!(
            parse_relaunch_argument(["--background"]),
            RelaunchArgument::Missing
        );
        assert_eq!(
            parse_relaunch_argument([valid, valid]),
            RelaunchArgument::Invalid
        );
        assert_eq!(
            parse_relaunch_argument([
                "--ghosteranti-update-attempt=0123456789ABCDEF0123456789ABCDEF"
            ]),
            RelaunchArgument::Invalid
        );
    }

    #[test]
    fn converts_namespaced_paths_and_keeps_nsis_directory_last_ready() {
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\C:\Program Files\GhosterAnti")),
            PathBuf::from(r"C:\Program Files\GhosterAnti")
        );
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\UNC\server\share\GhosterAnti")),
            PathBuf::from(r"\\server\share\GhosterAnti")
        );
        assert_eq!(
            nsis_directory_argument(Path::new(r"C:\Program Files\GhosterAnti")),
            OsString::from(r"/D=C:\Program Files\GhosterAnti")
        );
    }

    #[test]
    fn validates_the_running_root_against_all_registration_values() {
        let (_directory, executable, registration) = create_registered_install();
        let root = fs::canonicalize(executable.parent().unwrap()).unwrap();
        assert_eq!(
            validate_registration_snapshot(
                &executable,
                "0.1.0-beta.47",
                &registration,
                Some(&root)
            )
            .unwrap(),
            root
        );
    }

    #[test]
    fn rejects_missing_stale_or_different_registration_roots() {
        let (directory, executable, registration) = create_registered_install();
        let root = fs::canonicalize(executable.parent().unwrap()).unwrap();

        let mut missing = registration.clone();
        missing.install_location = None;
        assert_eq!(
            validate_registration_snapshot(&executable, "0.1.0-beta.47", &missing, Some(&root)),
            Err(UpdateAttemptError::RegistrationUnavailable)
        );

        let other = directory.path().join("other");
        fs::create_dir(&other).unwrap();
        let mut stale = registration.clone();
        stale.install_location = Some(other.display().to_string());
        assert_eq!(
            validate_registration_snapshot(&executable, "0.1.0-beta.47", &stale, Some(&root)),
            Err(UpdateAttemptError::RegistrationMismatch)
        );

        let mut wrong_version = registration;
        wrong_version.display_version = Some("0.1.0-beta.46".to_owned());
        assert_eq!(
            validate_registration_snapshot(
                &executable,
                "0.1.0-beta.47",
                &wrong_version,
                Some(&root)
            ),
            Err(UpdateAttemptError::RegistrationMismatch)
        );
    }

    #[test]
    fn requires_marker_root_version_and_exact_relaunch_for_success() {
        let directory = tempfile::tempdir().unwrap();
        let mut attempt = stored_attempt(directory.path());
        apply_reconciliation(
            &mut attempt,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
        );
        assert_eq!(attempt.state, StoredAttemptState::Succeeded);
        assert_eq!(attempt.failure_reason, None);

        let mut no_relaunch = stored_attempt(directory.path());
        apply_reconciliation(
            &mut no_relaunch,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: false,
            },
        );
        assert_eq!(
            no_relaunch.state,
            StoredAttemptState::InstalledRelaunchUnconfirmed
        );

        for evidence in [
            ReconciliationEvidence {
                marker_matches: false,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: false,
                current_version_matches: true,
                relaunch_matches: true,
            },
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: false,
                relaunch_matches: true,
            },
        ] {
            let mut failed = stored_attempt(directory.path());
            apply_reconciliation(&mut failed, evidence);
            assert_eq!(failed.state, StoredAttemptState::FailedOrInterrupted);
            assert!(failed.failure_reason.is_some());
        }
    }

    #[test]
    fn later_complete_evidence_can_replace_an_interrupted_result() {
        let directory = tempfile::tempdir().unwrap();
        let mut attempt = stored_attempt(directory.path());
        attempt.state = StoredAttemptState::FailedOrInterrupted;
        attempt.failure_reason = Some(UpdateFailureReason::InstallationUnconfirmed);
        apply_reconciliation(
            &mut attempt,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
        );
        assert_eq!(attempt.state, StoredAttemptState::Succeeded);
        assert_eq!(attempt.failure_reason, None);
    }

    #[test]
    fn stores_safe_attempts_atomically_and_serializes_no_path_to_ipc() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let handoff = handoff(&root);
        begin_attempt(directory.path(), &handoff, "0.1.0-beta.46", "0.1.0-beta.47").unwrap();
        assert_eq!(
            last_update_result(directory.path()).unwrap(),
            Some(LastUpdateResult::FailedOrInterrupted {
                from_version: "0.1.0-beta.46".to_owned(),
                expected_version: "0.1.0-beta.47".to_owned(),
                reason: UpdateFailureReason::InstallationUnconfirmed,
            })
        );
        let value = serde_json::to_value(last_update_result(directory.path()).unwrap()).unwrap();
        let text = value.to_string();
        assert!(!text.contains(&root.display().to_string()));
        assert!(!text.contains(&handoff.id));
    }

    #[test]
    fn records_only_the_matching_attempt_failure() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let handoff = handoff(&root);
        begin_attempt(directory.path(), &handoff, "old", "new").unwrap();
        assert_eq!(
            record_failure(
                directory.path(),
                "ffffffffffffffffffffffffffffffff",
                UpdateFailureReason::InstallerLaunch
            ),
            Err(UpdateAttemptError::InvalidRecord)
        );
        record_failure(
            directory.path(),
            &handoff.id,
            UpdateFailureReason::BrowserCleanup,
        )
        .unwrap();
        assert_eq!(
            last_update_result(directory.path()).unwrap(),
            Some(LastUpdateResult::FailedOrInterrupted {
                from_version: "old".to_owned(),
                expected_version: "new".to_owned(),
                reason: UpdateFailureReason::BrowserCleanup,
            })
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o755);
            // append_data refuses "..", so an escaping path is written into the header by hand.
            header.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, *contents).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn installed(directory: &Path) -> PathBuf {
        let root = directory.join("ghosteranti");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("lib").join("GhosterAnti")).unwrap();
        fs::write(root.join("bin").join("ghosteranti"), "old").unwrap();
        fs::write(root.join("lib").join("GhosterAnti").join("old-only"), "old").unwrap();
        root
    }

    #[test]
    fn replaces_the_whole_app_folder_and_keeps_modes() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = installed(directory.path());
        replace_linux_install(
            &root,
            &archive(&[
                ("GhosterAnti/bin/ghosteranti", b"new"),
                ("GhosterAnti/lib/GhosterAnti/firefox/ghosteranti", b"engine"),
            ]),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("bin").join("ghosteranti")).unwrap(),
            "new"
        );
        assert!(!root
            .join("lib")
            .join("GhosterAnti")
            .join("old-only")
            .exists());
        let mode = fs::metadata(root.join("lib/GhosterAnti/firefox/ghosteranti"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        let names: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("ghosteranti")]);
    }

    #[test]
    fn keeps_the_old_folder_when_the_update_is_unusable() {
        let directory = tempfile::tempdir().unwrap();
        let root = installed(directory.path());
        for bytes in [
            archive(&[("GhosterAnti/lib/GhosterAnti/only-resources", b"x")]),
            archive(&[
                ("GhosterAnti/bin/ghosteranti", b"new"),
                ("GhosterAnti/../../escape", b"x"),
            ]),
            b"not an archive".to_vec(),
        ] {
            assert!(replace_linux_install(&root, &bytes).is_err());
            assert_eq!(
                fs::read_to_string(root.join("bin").join("ghosteranti")).unwrap(),
                "old"
            );
            assert!(!directory.path().join("escape").exists());
            assert!(!directory.path().join(".ghosteranti-update").exists());
        }
    }

    #[test]
    fn finds_the_app_folder_from_its_program() {
        let directory = tempfile::tempdir().unwrap();
        let root = installed(directory.path());
        assert_eq!(
            install_root(&root.join("bin").join("ghosteranti")),
            Some(root.clone())
        );
        assert_eq!(install_root(&root.join("ghosteranti")), None);
        assert!(ensure_replaceable(&root).is_ok());
    }
}
