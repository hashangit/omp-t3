class OmpT3 < Formula
  desc "Connects T3 Code to Oh My Pi without code forks"
  homepage "https://github.com/hashangit/omp-t3"
  url "https://registry.npmjs.org/omp-t3/-/omp-t3-1.3.0-4.tgz"
  sha256 "671f88039f15d59c3224e966e388913a80e8ade1ad8984bc30a850d52ca94539"
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
