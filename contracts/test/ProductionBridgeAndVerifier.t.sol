// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockCanonicalTokenBridge} from "../src/mocks/MockCanonicalTokenBridge.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {SpokePortal} from "../src/spoke/SpokePortal.sol";
import {CanonicalBridgeAdapter} from "../src/spoke/CanonicalBridgeAdapter.sol";
import {AcrossBridgeAdapter} from "../src/spoke/AcrossBridgeAdapter.sol";
import {Verifier} from "../src/zk/Verifier.sol";
import {Groth16VerifierAdapter} from "../src/zk/Groth16VerifierAdapter.sol";

contract AlwaysTrueGroth16Verifier {
    function verifyProof(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

contract AlwaysFalseGroth16Verifier {
    function verifyProof(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return false;
    }
}

contract GeneratedGroth16VerifierTrue {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract GeneratedGroth16VerifierFalse {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata)
        external
        pure
        returns (bool)
    {
        return false;
    }
}

contract ProductionBridgeAndVerifierTest is TestBase {
    address internal user;

    function setUp() external {
        user = vm.addr(0xA11CE);
    }

    function test_canonicalBridgeAdapter_bridgesThroughConfiguredRoute() external {
        MockERC20 localToken = new MockERC20("Local USDC", "USDC", 6);
        MockERC20 remoteToken = new MockERC20("Remote USDC", "USDC", 6);
        MockCanonicalTokenBridge bridge = new MockCanonicalTokenBridge();

        SpokePortal portal = new SpokePortal(address(this), 8453);
        CanonicalBridgeAdapter adapter = new CanonicalBridgeAdapter(address(this));

        adapter.setAllowedCaller(address(portal), true);
        adapter.setRoute(address(localToken), address(bridge), address(remoteToken), 300_000, true);
        portal.setBridgeAdapter(address(adapter));
        portal.setHubRecipient(address(0xBEEF));

        uint256 amount = 50e6;
        localToken.mint(user, amount);

        vm.prank(user);
        localToken.approve(address(portal), amount);

        vm.prank(user);
        uint256 depositId = portal.initiateSupply(address(localToken), amount, user);

        assertEq(depositId, 1, "first deposit id should be 1");
        assertEq(localToken.balanceOf(address(bridge)), amount, "bridge should receive escrowed tokens");
        assertEq(bridge.lastLocalToken(), address(localToken), "bridge local token should match");
        assertEq(bridge.lastRemoteToken(), address(remoteToken), "bridge remote token should match");
        assertEq(bridge.lastRecipient(), address(0xBEEF), "hub recipient should match");
        assertEq(bridge.lastAmount(), amount, "amount should match");
        assertEq(uint256(bridge.lastMinGasLimit()), 300_000, "min gas limit should match route");
        assertEq(bridge.lastCaller(), address(adapter), "adapter should call canonical bridge");
    }

    function test_canonicalBridgeAdapter_rejectsUnauthorizedCallerAndMissingRoute() external {
        MockERC20 localToken = new MockERC20("Local USDC", "USDC", 6);
        CanonicalBridgeAdapter adapter = new CanonicalBridgeAdapter(address(this));

        localToken.mint(address(this), 1e6);
        localToken.approve(address(adapter), 1e6);

        vm.expectRevert(abi.encodeWithSelector(CanonicalBridgeAdapter.UnauthorizedCaller.selector, address(this)));
        adapter.bridgeToHub(address(localToken), 1e6, address(0xBEEF), bytes("x"));

        adapter.setAllowedCaller(address(this), true);

        vm.expectRevert(abi.encodeWithSelector(CanonicalBridgeAdapter.RouteNotEnabled.selector, address(localToken)));
        adapter.bridgeToHub(address(localToken), 1e6, address(0xBEEF), bytes("x"));
    }

    function test_acrossBridgeAdapter_bridgesThroughConfiguredRoute() external {
        MockERC20 localToken = new MockERC20("Local USDC", "USDC", 6);
        MockERC20 hubToken = new MockERC20("Hub USDC", "USDC", 6);
        MockAcrossSpokePool spokePool = new MockAcrossSpokePool();

        SpokePortal portal = new SpokePortal(address(this), 8453);
        AcrossBridgeAdapter adapter = new AcrossBridgeAdapter(address(this), 8453);

        adapter.setAllowedCaller(address(portal), true);
        adapter.setRoute(address(localToken), address(spokePool), address(hubToken), address(0), 300_000, true);
        portal.setBridgeAdapter(address(adapter));
        portal.setHubRecipient(address(0xBEEF));

        uint256 amount = 70e6;
        localToken.mint(user, amount);

        vm.prank(user);
        localToken.approve(address(portal), amount);

        vm.prank(user);
        uint256 depositId = portal.initiateSupply(address(localToken), amount, user);

        assertEq(depositId, 1, "first deposit id should be 1");
        assertEq(localToken.balanceOf(address(spokePool)), amount, "Across spoke pool should receive escrowed tokens");
        assertEq(spokePool.nextDepositId(), 1, "spoke pool deposit counter should increment");
    }

    function test_acrossBridgeAdapter_rejectsUnauthorizedCallerAndMissingRoute() external {
        MockERC20 localToken = new MockERC20("Local USDC", "USDC", 6);
        AcrossBridgeAdapter adapter = new AcrossBridgeAdapter(address(this), 8453);

        localToken.mint(address(this), 1e6);
        localToken.approve(address(adapter), 1e6);

        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeAdapter.UnauthorizedCaller.selector, address(this)));
        adapter.bridgeToHub(address(localToken), 1e6, address(0xBEEF), bytes("x"));

        adapter.setAllowedCaller(address(this), true);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeAdapter.RouteNotEnabled.selector, address(localToken)));
        adapter.bridgeToHub(address(localToken), 1e6, address(0xBEEF), bytes("x"));
    }

    function test_verifierProdModeRequiresRealVerifier() external {
        vm.expectRevert(abi.encodeWithSelector(Verifier.RealVerifierRequired.selector));
        new Verifier(address(this), false, bytes32(0), address(0), 4);
    }

    function test_verifierProdModeDelegatesToGroth16Verifier() external {
        AlwaysTrueGroth16Verifier trueVerifier = new AlwaysTrueGroth16Verifier();
        AlwaysFalseGroth16Verifier falseVerifier = new AlwaysFalseGroth16Verifier();

        Verifier verifier = new Verifier(address(this), false, bytes32(0), address(trueVerifier), 4);

        bytes memory proof = hex"1234";
        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = 1;
        publicInputs[1] = 8453;
        publicInputs[2] = 480;
        publicInputs[3] = 777;

        bool ok = verifier.verifyProof(proof, publicInputs);
        assertTrue(ok, "prod verifier should delegate to configured groth16 verifier");

        verifier.setGroth16Verifier(address(falseVerifier));
        ok = verifier.verifyProof(proof, publicInputs);
        assertTrue(!ok, "prod verifier should return delegated verifier result");
    }

    function test_verifierRejectsNonContractVerifierAddress() external {
        vm.expectRevert(abi.encodeWithSelector(Verifier.InvalidVerifierContract.selector, address(0x1234)));
        new Verifier(address(this), false, bytes32(0), address(0x1234), 4);

        AlwaysTrueGroth16Verifier trueVerifier = new AlwaysTrueGroth16Verifier();
        Verifier verifier = new Verifier(address(this), false, bytes32(0), address(trueVerifier), 4);

        vm.expectRevert(abi.encodeWithSelector(Verifier.InvalidVerifierContract.selector, address(0)));
        verifier.setGroth16Verifier(address(0));
    }

    function test_verifierRejectsEmptyProofAndWrongPublicInputCount() external {
        bytes memory devProof = bytes("ZKHUB_DEV_PROOF");
        Verifier verifier = new Verifier(address(this), true, keccak256(devProof), address(0), 4);

        uint256[] memory validInputs = new uint256[](4);
        validInputs[0] = 1;
        validInputs[1] = 8453;
        validInputs[2] = 480;
        validInputs[3] = 777;

        vm.expectRevert(abi.encodeWithSelector(Verifier.EmptyProof.selector));
        verifier.verifyProof(bytes(""), validInputs);

        uint256[] memory badInputs = new uint256[](3);
        badInputs[0] = 1;
        badInputs[1] = 8453;
        badInputs[2] = 480;

        vm.expectRevert(abi.encodeWithSelector(Verifier.InvalidPublicInputCount.selector, 3, 4));
        verifier.verifyProof(devProof, badInputs);
    }

    function test_verifierDevModeHashMatchOnly() external {
        bytes memory devProof = bytes("ZKHUB_DEV_PROOF");
        Verifier verifier = new Verifier(address(this), true, keccak256(devProof), address(0), 4);

        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = 1;
        publicInputs[1] = 8453;
        publicInputs[2] = 480;
        publicInputs[3] = 777;

        bool ok = verifier.verifyProof(devProof, publicInputs);
        assertTrue(ok, "matching proof hash should pass in dev mode");

        ok = verifier.verifyProof(bytes("WRONG_PROOF"), publicInputs);
        assertTrue(!ok, "wrong proof hash should fail in dev mode");
    }

    function test_groth16AdapterDecodesProofAndDelegates() external {
        GeneratedGroth16VerifierTrue generatedTrue = new GeneratedGroth16VerifierTrue();
        GeneratedGroth16VerifierFalse generatedFalse = new GeneratedGroth16VerifierFalse();

        Groth16VerifierAdapter adapter = new Groth16VerifierAdapter(address(this), address(generatedTrue));

        uint256[2] memory pA = [uint256(1), uint256(2)];
        uint256[2][2] memory pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
        uint256[2] memory pC = [uint256(7), uint256(8)];

        bytes memory encodedProof = abi.encode(pA, pB, pC);
        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = 1;
        publicInputs[1] = 8453;
        publicInputs[2] = 480;
        publicInputs[3] = 777;

        bool ok = adapter.verifyProof(encodedProof, publicInputs);
        assertTrue(ok, "adapter should delegate to generated verifier");

        adapter.setGeneratedVerifier(address(generatedFalse));
        ok = adapter.verifyProof(encodedProof, publicInputs);
        assertTrue(!ok, "adapter should return delegated false");
    }

    function test_groth16AdapterRejectsMalformedInputs() external {
        GeneratedGroth16VerifierTrue generatedTrue = new GeneratedGroth16VerifierTrue();
        Groth16VerifierAdapter adapter = new Groth16VerifierAdapter(address(this), address(generatedTrue));

        uint256[] memory badCount = new uint256[](3);
        vm.expectRevert(abi.encodeWithSelector(Groth16VerifierAdapter.InvalidPublicInputCount.selector, 3, 4));
        adapter.verifyProof(new bytes(32 * 8), badCount);

        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = 1;
        publicInputs[1] = 8453;
        publicInputs[2] = 480;
        publicInputs[3] = 777;

        vm.expectRevert(abi.encodeWithSelector(Groth16VerifierAdapter.InvalidProofLength.selector, 32, 32 * 8));
        adapter.verifyProof(new bytes(32), publicInputs);

        uint256[] memory badField = new uint256[](4);
        badField[0] = type(uint256).max;
        badField[1] = 1;
        badField[2] = 1;
        badField[3] = 1;
        vm.expectRevert();
        adapter.verifyProof(new bytes(32 * 8), badField);
    }
}
