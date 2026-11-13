fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().map(String::as_str).eq(["version", "--json"]) {
        println!("{{\"name\":\"testing-csm-ci-client\",\"version\":\"{}\"}}", env!("RELEASE_VERSION"));
    } else {
        println!("testing-csm-ci-client {}", env!("RELEASE_VERSION"));
    }
}
