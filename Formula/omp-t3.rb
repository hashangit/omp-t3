class OmpT3 < Formula
  desc "Connects T3 Code to Oh My Pi without code forks"
  homepage "https://github.com/hashangit/omp-t3"
  url "https://registry.npmjs.org/omp-t3/-/omp-t3-1.4.0-4.tgz"
  sha256 "c116a69bd44affce8317a94e75057fad1587796a2b5e02c01e3a4bb8ee121e51"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "omp-t3", shell_output("#{bin}/omp-t3 --version")
  end
end
