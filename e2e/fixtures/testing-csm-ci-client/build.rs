fn main() {
    println!("cargo:rerun-if-changed=.release-version");
    let version = std::fs::read_to_string(".release-version").unwrap();
    println!("cargo:rustc-env=RELEASE_VERSION={}", version.trim());
}
