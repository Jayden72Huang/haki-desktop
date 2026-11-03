//! Haki-owned macOS Keychain item. The raw value is never returned to the WebView.
const SERVICE: &str = "com.hackertrip.desktop.account";
const ACCOUNT: &str = "hackertrip.space";
pub(crate) fn valid(key: &str) -> bool {
    key.starts_with("ht_live_")
        && (24..=256).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
#[cfg(target_os = "macos")]
mod native {
    use std::{
        ffi::{c_char, c_void},
        ptr,
    };
    type Item = *mut c_void;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const c_char,
            account_len: u32,
            account: *const c_char,
            len: *mut u32,
            data: *mut *mut c_void,
            item: *mut Item,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const c_char,
            account_len: u32,
            account: *const c_char,
            len: u32,
            data: *const c_void,
            item: *mut Item,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: Item,
            attributes: *const c_void,
            len: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> i32;
        fn SecKeychainItemDelete(item: Item) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(item: *const c_void);
    }
    const NOT_FOUND: i32 = -25300;
    pub fn load(service: &str, account: &str) -> Result<Option<String>, String> {
        let mut len = 0;
        let mut data = ptr::null_mut();
        // Security allocates data on success; copy before freeing with its matching allocator.
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr().cast(),
                account.len() as u32,
                account.as_ptr().cast(),
                &mut len,
                &mut data,
                ptr::null_mut(),
            )
        };
        if status == NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            return Err("KEYCHAIN_READ_FAILED".into());
        }
        let value = if data.is_null() {
            Err("KEYCHAIN_INVALID_DATA".into())
        } else {
            String::from_utf8(
                unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len as usize) }.to_vec(),
            )
            .map(Some)
            .map_err(|_| "KEYCHAIN_INVALID_DATA".into())
        };
        if !data.is_null() {
            unsafe {
                SecKeychainItemFreeContent(ptr::null_mut(), data);
            }
        }
        value
    }
    pub fn save(service: &str, account: &str, key: &str) -> Result<(), String> {
        let mut item: Item = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr().cast(),
                account.len() as u32,
                account.as_ptr().cast(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        let result = if status == 0 {
            let result = unsafe {
                SecKeychainItemModifyAttributesAndData(
                    item,
                    ptr::null(),
                    key.len() as u32,
                    key.as_ptr().cast(),
                )
            };
            if !item.is_null() {
                unsafe {
                    CFRelease(item);
                }
            }
            result
        } else if status == NOT_FOUND {
            unsafe {
                SecKeychainAddGenericPassword(
                    ptr::null(),
                    service.len() as u32,
                    service.as_ptr().cast(),
                    account.len() as u32,
                    account.as_ptr().cast(),
                    key.len() as u32,
                    key.as_ptr().cast(),
                    ptr::null_mut(),
                )
            }
        } else {
            status
        };
        if result == 0 {
            Ok(())
        } else {
            Err("KEYCHAIN_SAVE_FAILED".into())
        }
    }
    pub fn clear(service: &str, account: &str) -> Result<(), String> {
        let mut item: Item = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                service.len() as u32,
                service.as_ptr().cast(),
                account.len() as u32,
                account.as_ptr().cast(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        if status == NOT_FOUND {
            return Ok(());
        }
        if status != 0 {
            return Err("KEYCHAIN_READ_FAILED".into());
        }
        let result = unsafe { SecKeychainItemDelete(item) };
        if !item.is_null() {
            unsafe {
                CFRelease(item);
            }
        }
        if result == 0 {
            Ok(())
        } else {
            Err("KEYCHAIN_DELETE_FAILED".into())
        }
    }
    #[test]
    #[ignore = "Writes and removes one isolated fixture Keychain item; never touches the account credential"]
    fn fixture_keychain_roundtrip() {
        let account = format!("fixture-{}", std::process::id());
        let service = "com.hackertrip.desktop.tests";
        save(
            service,
            &account,
            "ht_live_fixture_abcdefghijklmnopqrstuvwxyz",
        )
        .unwrap();
        let result = load(service, &account);
        let cleanup = clear(service, &account);
        assert_eq!(
            result.unwrap().as_deref(),
            Some("ht_live_fixture_abcdefghijklmnopqrstuvwxyz")
        );
        cleanup.unwrap();
        assert!(load(service, &account).unwrap().is_none());
    }
}
#[cfg(target_os = "macos")]
pub fn save(key: &str) -> Result<(), String> {
    if !valid(key) {
        return Err("INVALID_DESKTOP_KEY".into());
    }
    native::save(SERVICE, ACCOUNT, key)
}
#[cfg(target_os = "macos")]
pub fn load() -> Result<Option<String>, String> {
    native::load(SERVICE, ACCOUNT)
}
#[cfg(target_os = "macos")]
pub fn clear() -> Result<(), String> {
    native::clear(SERVICE, ACCOUNT)
}
#[cfg(not(target_os = "macos"))]
pub fn save(_: &str) -> Result<(), String> {
    Err("SECURE_STORAGE_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub fn load() -> Result<Option<String>, String> {
    Err("SECURE_STORAGE_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub fn clear() -> Result<(), String> {
    Err("SECURE_STORAGE_UNSUPPORTED".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_credential_shapes() {
        assert!(!valid("ht_live_short"));
        assert!(!valid("ht_live_abcdefghijklmnopqrstuvwxyz\n"));
        assert!(valid("ht_live_abcdefghijklmnopqrstuvwxyz0123456789"));
    }
}
